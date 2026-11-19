import { getState, patch, upsertTicker, SPOT_WS, FUT_WS, MAJORS, type LinkState } from "./store";

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

export function startFutSocket(): SockCtl {
  const streams = ["!forceOrder@arr", ...MAJORS.map((s) => s.toLowerCase() + "@markPrice@1s")].join("/");
  return connectWithTimeout(
    FUT_WS,
    (base) => base + streams,
    {
      name: "fut",
      waitMs: 5000,
      silentMs: 25000,
      labels: { live: "期货实时", down: "期货不可用", wait: "期货连接…" },
      onMsg(payload) {
        const d = (payload as { data?: Record<string, unknown> })?.data || payload as Record<string, unknown>;
        if (!d) return;
        if (d.e === "forceOrder" && d.o) {
          const o = d.o as { s: string; S: string; ap?: string; p?: string; q?: string };
          const px = +(o.ap || o.p || 0);
          const rec = { t: +(d.E || Date.now()), s: o.s, side: o.S === "BUY" ? "空" : "多", px, usd: px * +(o.q || 0) };
          const liqs = [rec, ...getState().liqs].slice(0, 80);
          patch({ liqs });
        } else if (d.r != null && d.s) {
          const funding = { ...getState().funding };
          funding[String(d.s)] = {
            rate: +d.r, source: "币安期货推送", t: Date.now(),
            mark: d.p != null ? +d.p : undefined,
            next: d.T != null ? +d.T : undefined,
            oiUsd: funding[String(d.s)]?.oiUsd,
          };
          patch({ funding });
        }
      },
    }
  );
}

export function startDepthSocket(symbol: string, onTrade?: (t: { t: number; p: number; q: number; m: boolean }) => void): SockCtl {
  const s = symbol.toLowerCase();
  const path = `/${s}@depth20@100ms/${s}@aggTrade`;
  let tradesCtlIgnore = onTrade;
  return connectWithTimeout(
    SPOT_WS,
    (base) => base.replace(/\/$/, "") + path,
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
  let sock: WebSocket | null = null, dead = false, timer: number | null = null, idx = 0;
  const s = symbol.toLowerCase();
  const open = () => {
    if (dead) return;
    const base = SPOT_WS[idx % SPOT_WS.length].replace(/\/$/, "");
    const url = `${base}/stream?streams=${s}@depth20@100ms/${s}@aggTrade`;
    try { sock = new WebSocket(url); } catch { idx++; timer = window.setTimeout(open, 1500); return; }
    const opened = Date.now();
    let got = 0;
    timer = window.setTimeout(() => { if (!got) sock?.close(); }, 4000);
    sock.onmessage = (ev) => {
      got++;
      if (timer) { clearTimeout(timer); timer = window.setTimeout(() => sock?.close(), 15000); }
      try {
        const msg = JSON.parse(ev.data) as { stream?: string; data?: Record<string, unknown> };
        const d = msg.data || {};
        if (String(msg.stream || "").includes("depth")) {
          const bids = ((d.bids || d.b) as string[][] || []).map(([p, q]) => ({ p: +p, q: +q }));
          const asks = ((d.asks || d.a) as string[][] || []).map(([p, q]) => ({ p: +p, q: +q }));
          if (bids.length || asks.length) patch({ book: { bids, asks } });
        } else if (String(msg.stream || "").includes("aggTrade")) {
          const t = { t: +(d.T || d.E || Date.now()), p: +d.p!, q: +d.q!, m: !!d.m };
          patch({ trades: [t, ...getState().trades].slice(0, 80) });
        }
      } catch { /* */ }
    };
    sock.onclose = () => {
      if (dead) return;
      if (Date.now() - opened < 4000 && got === 0) idx++;
      timer = window.setTimeout(open, got ? 2000 : 2500);
    };
  };
  open();
  return { close() { dead = true; if (timer) clearTimeout(timer); try { sock?.close(); } catch { /* */ } } };
}
