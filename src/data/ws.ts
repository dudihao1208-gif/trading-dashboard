import { getState, patch, upsertTicker, setStamp, SPOT_WS, FUT_WS, MAJORS, LEV_RE, type LinkState } from "./store";
import { refreshFunding, fetchDepth } from "./api";

/** 合并流必须是 /stream?streams=a/b，不能接在 /ws 后面。 */
function combinedStreamUrl(wsBase: string, streams: string) {
  const origin = wsBase.replace(/\/ws\/?$/, "").replace(/\/stream\?streams=.*$/, "").replace(/\/$/, "");
  return `${origin}/stream?streams=${streams}`;
}

type Handlers = {
  onSpotLive?: () => void;
};

export type SockCtl = { close: () => void };

function connectWithTimeout(
  urls: string[],
  makePath: (base: string) => string,
  opts: {
    name: "spot" | "fut";
    waitMs: number;
    silentMs: number;
    labels: { live: string; rest?: string; down: string; wait: string };
    onMsg: (data: unknown) => void;
    onDown?: () => void;
  }
): SockCtl {
  let idx = 0, sock: WebSocket | null = null, dead = false, timer: number | null = null, openedAt = 0, got = 0;

  const set = (state: LinkState, label: string, detail: string) => {
    // 已经判定不可用后，后台重试不要再显示「连接中」
    const cur = opts.name === "spot" ? getState().spot : getState().fut;
    if (state === "wait" && cur.state === "down") return;
    if (opts.name === "spot") patch({ spot: { state, label, detail } });
    else patch({ fut: { state, label, detail } });
  };

  const arm = (ms: number, fn: () => void) => {
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(fn, ms);
  };

  const open = () => {
    if (dead) return;
    const base = urls[idx % urls.length];
    const url = makePath(base);
    set("wait", opts.labels.wait, url.replace(/^wss:\/\//, ""));
    try { sock = new WebSocket(url); } catch {
      idx += 1;
      arm(1200, open);
      return;
    }
    openedAt = Date.now();
    got = 0;
    // 绝不长时间停在「连接中」
    arm(opts.waitMs, () => {
      if (dead || got > 0) return;
      try { sock?.close(); } catch { /* */ }
    });
    sock.onmessage = (ev) => {
      got += 1;
      if (got === 1) set("live", opts.labels.live, url.replace(/^wss:\/\//, ""));
      arm(opts.silentMs, () => {
        try { sock?.close(); } catch { /* */ }
      });
      try { opts.onMsg(JSON.parse(ev.data)); } catch { /* */ }
    };
    sock.onerror = () => { /* onclose 处理 */ };
    sock.onclose = () => {
      if (dead) return;
      const quickFail = Date.now() - openedAt < opts.waitMs && got === 0;
      if (quickFail) idx += 1;
      const triedAll = idx >= urls.length && got === 0;
      if (triedAll || (got === 0 && idx > urls.length * 2)) {
        set("down", opts.labels.down, "当前网络无法订阅该推送，已改用备用或暂停");
        opts.onDown?.();
        // 放慢重试，避免一直显示连接中
        arm(20000, () => { idx = idx % urls.length; open(); });
        return;
      }
      if (got === 0) set("down", opts.labels.down, "无数据，正在换线路");
      arm(got ? 2000 : 1500, open);
    };
  };
  open();
  return {
    close() {
      dead = true;
      if (timer) clearTimeout(timer);
      try { sock?.close(); } catch { /* */ }
    },
  };
}

export function startSpotSocket(_h: Handlers = {}): SockCtl {
  return connectWithTimeout(
    SPOT_WS,
    (base) => base.replace(/\/$/, "") + "/!miniTicker@arr",
    {
      name: "spot",
      waitMs: 4000,
      silentMs: 20000,
      labels: { live: "现货实时", down: "现货不可用", wait: "现货连接…" },
      onMsg(data) {
        const rows = Array.isArray(data) ? data : (data as { data?: unknown[] })?.data || [data];
        for (const r of rows as { s?: string; c?: string; o?: string; h?: string; l?: string; v?: string; q?: string }[]) {
          if (!r?.s) continue;
          upsertTicker(r.s, { c: +r.c!, o: +r.o!, h: +r.h!, l: +r.l!, v: +r.v!, q: +r.q!, src: "ws" });
        }
      },
      onDown() {
        const { spot } = getState();
        if (spot.state !== "live") patch({ spot: { state: "rest", label: "现货 REST", detail: "推送不可用，轮询备用" } });
      },
    }
  );
}

function applyBinanceMarks(rows: Record<string, unknown>[]) {
  const funding = { ...getState().funding };
  let n = 0;
  for (const d of rows) {
    const s = String(d.s || "");
    if (!s.endsWith("USDT") || LEV_RE.test(s)) continue;
    if (d.r == null) continue;
    const rate = +d.r;
    if (!Number.isFinite(rate)) continue;
    const prev = funding[s];
    funding[s] = {
      rate,
      source: "币安",
      t: Date.now(),
      mark: d.p != null ? +d.p : prev?.mark,
      next: d.T != null ? +d.T : prev?.next,
      oiUsd: prev?.oiUsd,
    };
    n++;
  }
  if (!n) return;
  patch({ funding });
  setStamp("heat", `币安 · ${Object.keys(funding).filter((k) => k.endsWith("USDT")).length} 个永续`);
}

export function startFutSocket(): SockCtl {
  // 全市场资金费 + 爆仓 + 主要交易对单币流（意大利等非限制地区可直连）
  const streams = [
    "!markPrice@arr@1s",
    "!forceOrder@arr",
    ...MAJORS.map((s) => s.toLowerCase() + "@markPrice@1s"),
  ].join("/");
  return connectWithTimeout(
    FUT_WS,
    (base) => base + streams,
    {
      name: "fut",
      waitMs: 4000,
      silentMs: 25000,
      labels: { live: "币安", down: "期货不可用", wait: "期货连接…" },
      onMsg(payload) {
        const msg = payload as { stream?: string; data?: unknown };
        const data = (msg.data !== undefined ? msg.data : payload) as unknown;
        if (Array.isArray(data)) {
          applyBinanceMarks(data as Record<string, unknown>[]);
          return;
        }
        const d = (data || {}) as Record<string, unknown>;
        if (d.e === "forceOrder" && d.o) {
          const o = d.o as { s: string; S: string; ap?: string; p?: string; q?: string };
          const px = +(o.ap || o.p || 0);
          const rec = { t: +(d.E || Date.now()), s: o.s, side: o.S === "BUY" ? "空" : "多", px, usd: px * +(o.q || 0) };
          patch({ liqs: [rec, ...getState().liqs].slice(0, 80) });
        } else if (d.e === "markPriceUpdate" || (d.r != null && d.s)) {
          applyBinanceMarks([d]);
        }
      },
      onDown() {
        const heat = getState().stamps.heat?.text || "";
        if (!heat.startsWith("币安")) {
          refreshFunding().catch(() => {});
        }
      },
    }
  );
}

export function startDepthSocket(symbol: string, onTrade?: (t: { t: number; p: number; q: number; m: boolean }) => void): SockCtl {
  const s = symbol.toLowerCase();
  let tradesCtlIgnore = onTrade;
  return connectWithTimeout(
    SPOT_WS,
    (base) => combinedStreamUrl(base, `${s}@depth20@100ms/${s}@aggTrade`),
    {
      name: "spot",
      waitMs: 4000,
      silentMs: 15000,
      labels: {
        live: getState().spot.state === "live" ? "现货实时" : "现货实时",
        down: getState().spot.label,
        wait: getState().spot.label,
      },
      onMsg(payload) {
        const msg = payload as { stream?: string; data?: Record<string, unknown> } & Record<string, unknown>;
        const stream = String(msg.stream || "");
        const d = (msg.data || msg) as Record<string, unknown>;
        if (stream.includes("depth") || d.bids || d.asks) {
          const bids = ((d.bids || d.b) as string[][] || []).map(([p, q]) => ({ p: +p, q: +q }));
          const asks = ((d.asks || d.a) as string[][] || []).map(([p, q]) => ({ p: +p, q: +q }));
          if (bids.length || asks.length) patch({ book: { bids, asks } });
        }
        if (stream.includes("aggTrade") || d.e === "aggTrade") {
          const t = { t: +(d.T || d.E || Date.now()), p: Number(d.p), q: Number(d.q), m: !!d.m };
          const prev = getState().trades;
          patch({ trades: [t, ...prev].slice(0, 80) });
          tradesCtlIgnore?.(t);
        }
      },
    }
  );
}

// 盘口专用：不要覆盖主现货状态。单独实现轻量 socket。
export function startBookTrades(symbol: string): SockCtl {
  let sock: WebSocket | null = null, dead = false, timer: number | null = null, idx = 0, poll: number | null = null;
  const s = symbol.toLowerCase();
  const stampBook = (book: { bids: { p: number; q: number }[]; asks: { p: number; q: number }[] }) => {
    patch({ book, bookAt: Date.now(), bookLive: true, bookSrc: "实时" });
  };
  const stampTrade = (tr: { t: number; p: number; q: number; m: boolean }) => {
    patch({ trades: [tr, ...getState().trades].slice(0, 80), tradesAt: Date.now(), bookLive: true, bookSrc: getState().bookSrc || "实时" });
  };
  const open = () => {
    if (dead) return;
    const base = SPOT_WS[idx % SPOT_WS.length];
    const url = combinedStreamUrl(base, `${s}@depth20@100ms/${s}@aggTrade`);
    try { sock = new WebSocket(url); } catch { idx++; timer = window.setTimeout(open, 1500); return; }
    const opened = Date.now();
    let got = 0;
    timer = window.setTimeout(() => { if (!got) sock?.close(); }, 4000);
    sock.onmessage = (ev) => {
      got++;
      if (timer) { clearTimeout(timer); timer = window.setTimeout(() => sock?.close(), 15000); }
      try {
        const msg = JSON.parse(ev.data) as { stream?: string; data?: Record<string, unknown> };
        const d = (msg.data || msg) as Record<string, unknown>;
        const stream = String(msg.stream || "");
        if (stream.includes("depth") || d.bids || d.asks || d.b || d.a) {
          const bids = ((d.bids || d.b) as string[][] || []).map(([p, q]) => ({ p: +p, q: +q }));
          const asks = ((d.asks || d.a) as string[][] || []).map(([p, q]) => ({ p: +p, q: +q }));
          if (bids.length || asks.length) stampBook({ bids, asks });
        } else if (stream.includes("aggTrade") || d.e === "aggTrade") {
          stampTrade({ t: +(d.T || d.E || Date.now()), p: Number(d.p), q: Number(d.q), m: !!d.m });
        }
      } catch { /* */ }
    };
    sock.onclose = () => {
      if (dead) return;
      if (getState().bookLive) patch({ bookLive: false });
      if (Date.now() - opened < 4000 && got === 0) idx++;
      timer = window.setTimeout(open, got ? 2000 : 2500);
    };
  };
  open();
  const restTick = () => {
    if (dead) return;
    const st = getState();
    if (!st.bookLive || Date.now() - st.bookAt > 4000) {
      fetchDepth(symbol).catch(() => {});
    }
  };
  poll = window.setInterval(restTick, 5000);
  restTick();
  return {
    close() {
      dead = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      try { sock?.close(); } catch { /* */ }
    },
  };
}
