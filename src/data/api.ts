import { underlyingOf, sanePremium } from "./map";
import {
  getJSON, firstOK, getState, patch, setStamp, upsertTicker, via, workerOn,
  SPOT_REST, OKX, FNG, CG_GLOBAL, CG_XSTOCKS, CG_DERIV, MAJORS, LEV_RE,
  instOf, nextFundingTime, type Funding, type XStock, type BookLevel,
} from "./store";

export async function mapPool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const cur = items[i++];
      try { await fn(cur); } catch { /* skip */ }
    }
  }));
}

export async function refreshSpotRest() {
  try {
    const r = await firstOK<Array<Record<string, string>>>(SPOT_REST, "/api/v3/ticker/24hr", 15000);
    for (const row of r.data) {
      const s = row.symbol;
      if (!s?.endsWith("USDT") || LEV_RE.test(s)) continue;
      upsertTicker(s, {
        c: +row.lastPrice, o: +row.openPrice, h: +row.highPrice, l: +row.lowPrice,
        v: +row.volume, q: +row.quoteVolume, chg: +row.priceChangePercent, src: "rest",
      });
    }
    const { spot } = getState();
    if (spot.state !== "live") {
      patch({ spot: { state: "rest", label: "现货 REST", detail: r.base.replace("https://", "") } });
    }
    setStamp("majors", "REST · " + r.base.replace("https://", ""));
  } catch {
    const { spot } = getState();
    if (spot.state !== "live") patch({ spot: { state: "down", label: "现货不可用", detail: "行情接口失败" } });
    setStamp("majors", "现货行情失败", true);
  }
}

export async function refreshMacro() {
  try {
    const g = await getJSON<{ data?: { total_market_cap?: { usd?: number }; market_cap_percentage?: { btc?: number }; total_volume?: { usd?: number } } }>(CG_GLOBAL, 10000);
    const d = g.data;
    patch({ macros: { ...getState().macros, mcap: d?.total_market_cap?.usd, dom: d?.market_cap_percentage?.btc, vol: d?.total_volume?.usd } });
  } catch { /* keep last */ }
  try {
    const f = await getJSON<{ data?: { value?: string; value_classification?: string }[] }>(FNG, 8000);
    const row = f.data?.[0];
    if (row) {
      const map: Record<string, string> = {
        "Extreme Fear": "极度恐慌", Fear: "恐慌", Neutral: "中性", Greed: "贪婪", "Extreme Greed": "极度贪婪",
      };
      const raw = row.value_classification || "";
      patch({ macros: { ...getState().macros, fng: +(row.value || 0), fngClass: map[raw] || raw } });
    }
  } catch { /* keep last */ }
}


/** OKX：fundingTime 是本周期即将到来的结算；nextFundingTime 是再下一期。 */
function okxFundingNext(row: { fundingTime?: string; nextFundingTime?: string }) {
  const now = Date.now();
  const ft = row.fundingTime ? +row.fundingTime : 0;
  const nft = row.nextFundingTime ? +row.nextFundingTime : 0;
  if (ft > now + 30_000) return ft;
  if (nft > now + 30_000) return nft;
  return nextFundingTime();
}

function freshBinance(f?: Funding) {
  return !!f && (f.source || "").includes("币安") && Date.now() - f.t < 120_000;
}

export async function refreshFunding() {
  const funding: Record<string, Funding> = { ...getState().funding };
  let src = Object.values(funding).some(freshBinance) ? "币安" : "";

  // 不在浏览器直连 fapi REST：即便在意大利也没有 CORS，只会在控制台刷红。
  // 币安费率改由 fstream WebSocket（applyBinanceMarks）写入；此处用 OKX 补齐。

  // 2) OKX 持仓量；仅给尚无币安报价的合约补资金费
  try {
    const oi = await getJSON<{ code?: string; data?: { instId: string; oiUsd: string }[] }>(OKX + "/api/v5/public/open-interest?instType=SWAP", 12000);
    const rows = (oi.code === "0" ? oi.data : []) || [];
    const map: Record<string, { instId: string; oiUsd: number }> = {};
    const usdt = rows
      .filter((x) => x.instId?.endsWith("-USDT-SWAP"))
      .map((x) => ({ instId: x.instId, oiUsd: +x.oiUsd, sym: x.instId.replace("-USDT-SWAP", "USDT") }))
      .sort((a, b) => b.oiUsd - a.oiUsd);
    for (const x of usdt) map[x.instId] = { instId: x.instId, oiUsd: x.oiUsd };
    patch({ oi: map });
    const need = usdt.filter((x) => !freshBinance(funding[x.sym])).slice(0, 60);
    if (need.length) {
      await mapPool(need, 8, async (x) => {
        if (freshBinance(funding[x.sym])) return;
        const data = await getJSON<{ code?: string; data?: { fundingRate: string; fundingTime?: string; nextFundingTime?: string }[] }>(
          `${OKX}/api/v5/public/funding-rate?instId=${x.instId}`, 8000
        );
        if (data.code === "0" && data.data?.[0]) {
          funding[x.sym] = {
            rate: +data.data[0].fundingRate,
            source: "OKX",
            t: Date.now(),
            next: okxFundingNext(data.data[0]),
            oiUsd: x.oiUsd,
          };
        }
      });
      if (!src) src = "OKX";
    }
    for (const [sym, f] of Object.entries(funding)) {
      const inst = instOf(sym);
      if (map[inst] && f.oiUsd == null) f.oiUsd = map[inst].oiUsd;
    }
  } catch { /* */ }

  // 3) 仍不足 50 个：CoinGecko 衍生品
  if (Object.keys(funding).length < 50) {
    try {
      const list = await getJSON<Array<{ symbol?: string; market?: string; contract_type?: string; funding_rate?: number; open_interest?: number; volume_24h?: number }>>(CG_DERIV, 15000);
      const perps = (list || [])
        .filter((x) => (x.contract_type || "").toLowerCase() === "perpetual" && String(x.symbol || "").endsWith("USDT"))
        .sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0))
        .slice(0, 80);
      for (const x of perps) {
        const sym = String(x.symbol);
        if (funding[sym]) continue;
        let rate = Number(x.funding_rate);
        if (!Number.isFinite(rate)) continue;
        // CoinGecko 常见为已乘 100 的百分数（如 0.01 表示 0.01%）
        if (Math.abs(rate) > 0.05) rate = rate / 100; // 保守：过大则视为小数
        else if (Math.abs(rate) >= 0.000001 && Math.abs(rate) <= 0.05) {
          // 0.01 更像是 0.01% 而非 1%
          rate = rate / 100;
        }
        funding[sym] = { rate, source: "CoinGecko", t: Date.now(), next: nextFundingTime(), oiUsd: x.open_interest };
      }
      if (!src) src = "CoinGecko";
    } catch { /* */ }
  }

  patch({ funding });
  const n = Object.keys(funding).length;
  setStamp("heat", n ? `${src} · ${n} 个永续` : "资金费暂不可用", !n);
}

export async function fetchKlines(symbol: string, interval: string, limit = 400) {
  const r = await firstOK<Array<(string | number)[]>>(
    SPOT_REST,
    `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,
    15000
  );
  return { base: r.base, rows: r.data };
}

export async function fetchDepth(symbol: string) {
  const r = await firstOK<{ bids: string[][]; asks: string[][] }>(
    SPOT_REST, `/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=20`, 8000
  );
  const bids: BookLevel[] = r.data.bids.map(([p, q]) => ({ p: +p, q: +q }));
  const asks: BookLevel[] = r.data.asks.map(([p, q]) => ({ p: +p, q: +q }));
  const live = getState().bookLive && Date.now() - getState().bookAt < 4000;
  patch({ book: { bids, asks }, bookAt: Date.now(), bookSrc: live ? getState().bookSrc : "REST", bookLive: live });
  return r.base;
}

type RubikPt = { t: number; a: number; b?: number };

export async function fetchRubik(kind: "oi" | "ls" | "taker", ccy: string): Promise<{ ok: boolean; pts: RubikPt[]; note: string }> {
  const inst = `${ccy}-USDT-SWAP`;
  const urls: Record<typeof kind, string> = {
    oi: `${OKX}/api/v5/rubik/stat/contracts/open-interest-history?instId=${inst}&period=1H`,
    ls: `${OKX}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${ccy}&period=1H`,
    taker: `${OKX}/api/v5/rubik/stat/taker-volume?ccy=${ccy}&period=1H&instType=CONTRACTS`,
  };
  const tryOnce = async (useW: boolean) => {
    const url = useW ? via(urls[kind]) : urls[kind];
    return getJSON<{ code?: string; data?: (string | number)[][] }>(url, 10000, false);
  };
  const run = async (useW: boolean) => {
    const d = await tryOnce(useW);
    if (d.code !== "0" || !d.data?.length) throw new Error("empty");
    const pts: RubikPt[] = d.data.map((row) => {
      if (kind === "oi") return { t: +row[0], a: +(row[3] || row[1]) };
      if (kind === "ls") return { t: +row[0], a: +row[1] };
      return { t: +row[0], a: +row[2], b: +row[1] }; // buy, sell
    }).filter((p) => p.t && Number.isFinite(p.a)).sort((x, y) => x.t - y.t);
    return pts;
  };
  const tryWorkerFirst = workerOn();
  try {
    const pts = await run(tryWorkerFirst);
    return { ok: true, pts, note: tryWorkerFirst ? "OKX · Worker" : "OKX" };
  } catch {
    if (tryWorkerFirst) {
      try {
        const pts = await run(false);
        return { ok: true, pts, note: "OKX" };
      } catch {
        return { ok: false, pts: [], note: "Worker 已配置但拉取失败" };
      }
    }
    return { ok: false, pts: [], note: "该数据需配置 Cloudflare Worker 代理（OKX 统计接口在浏览器中常被跨域拦截）" };
  }
}

export { underlyingOf } from "./map";

type EquityQuote = { price: number; change_percent: number | null; name?: string; daily_closes?: { t: number; c: number }[] };

async function yahooViaWorker(sym: string): Promise<EquityQuote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
  try {
    const data = await getJSON<{
      chart?: { result?: Array<{
        meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number; shortName?: string; longName?: string };
        timestamp?: number[];
        indicators?: { quote?: Array<{ close?: (number | null)[] }> };
      }> };
    }>(via(url), 10000, false);
    const result = data.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta || {};
    const closes = result.indicators?.quote?.[0]?.close || [];
    const ts = result.timestamp || [];
    const valid = closes.filter((c): c is number => c != null);
    let last = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose || meta.previousClose;
    let change_percent: number | null = null;
    if (last != null && prev) change_percent = (last / prev - 1) * 100;
    else if (valid.length >= 2) {
      change_percent = (valid[valid.length - 1] / valid[valid.length - 2] - 1) * 100;
      last = last ?? valid[valid.length - 1];
    }
    if (last == null) return null;
    return {
      price: last,
      change_percent,
      name: meta.shortName || meta.longName || sym,
      daily_closes: ts.map((t, i) => ({ t, c: closes[i] as number })).filter((x) => x.c != null).slice(-30),
    };
  } catch {
    return null;
  }
}

export async function refreshStocks() {
  let equities: Record<string, EquityQuote> = {};
  let eqAt = "";
  let eqSrc = "";
  try {
    const eq = await getJSON<{ generated_at?: string; quotes?: Record<string, EquityQuote> }>("public-data/equities.json", 8000);
    equities = eq.quotes || {};
    eqAt = eq.generated_at || "";
    if (Object.keys(equities).length) eqSrc = "public-data";
  } catch { /* 无文件 */ }
  try {
    const list = await getJSON<Array<{ id: string; symbol: string; name: string; current_price: number; price_change_percentage_24h: number }>>(CG_XSTOCKS, 12000);
    const need = Array.from(new Set((list || []).map((c) => underlyingOf(c.symbol)).filter((u): u is string => !!u && !equities[u]?.price)));
    if (workerOn() && need.length) {
      await mapPool(need.slice(0, 16), 4, async (sym) => {
        const q = await yahooViaWorker(sym);
        if (q) equities[sym] = q;
      });
      if (need.some((s) => equities[s]?.price)) eqSrc = eqSrc ? eqSrc + " · Yahoo/Worker" : "Yahoo · Worker";
    }
    // 先尝试 Worker 缓存的正股（Actions 日历未跑时也能用）
    if (workerOn() && !Object.keys(equities).length) {
      try {
        const w = await getJSON<{ generated_at?: string; quotes?: Record<string, EquityQuote>; stale?: boolean }>(via("/equities"), 10000, false);
        if (w.quotes && Object.keys(w.quotes).length) {
          equities = w.quotes;
          eqAt = w.generated_at || eqAt;
          eqSrc = w.stale ? "Worker 缓存（可能过期）" : "Worker";
        }
      } catch { /* */ }
    }
    const xstocks: XStock[] = (list || []).map((c) => {
      const u = underlyingOf(c.symbol);
      const eq = u ? equities[u] : undefined;
      let premium: number | null = null;
      let absurd = false;
      if (eq?.price && c.current_price) {
        const raw = (c.current_price / eq.price - 1) * 100;
        premium = sanePremium(c.current_price, eq.price);
        absurd = premium == null && Number.isFinite(raw);
      }
      return {
        id: c.id, symbol: (c.symbol || "").toUpperCase(), name: c.name, price: c.current_price, chg: c.price_change_percentage_24h,
        under: eq?.price ? { symbol: u!, price: eq.price, chg: eq.change_percent, name: eq.name } : u ? { symbol: u, price: 0, chg: null } : undefined,
        premium, corr: null, noUnder: u === null || absurd,
      };
    });
    patch({ xstocks, stocksAt: eqAt || new Date().toISOString() });
    setStamp("stocks", "CoinGecko" + (eqSrc ? " · 正股 " + eqSrc : " · 正股待刷新") + (eqAt ? " · " + eqAt : ""));
  } catch {
    setStamp("stocks", "代币列表加载失败", true);
  }
}

type AppCal = { title: string; country: string; date: string; impact: string; forecast: string; previous: string };

export async function refreshCalendar() {
  const apply = (events: AppCal[], at: string, label: string, stale = false) => {
    patch({ calendar: events, calendarAt: at || new Date().toISOString() });
    setStamp("cal", label + (stale ? " · 已过期" : ""), stale && !events.length);
  };
  const staleOf = (at?: string) => !!at && Date.now() - Date.parse(at) > 8 * 3600_000;
  try {
    const data = await getJSON<{ generated_at?: string; events?: AppCal[] }>("public-data/calendar.json", 8000);
    if (data.events?.length && !staleOf(data.generated_at)) {
      apply(data.events, data.generated_at || "", "宏观日历 · 仓库");
      return;
    }
    // 仓库没有或已过期，再试 Worker 缓存（避免 Forex Factory 429）
    if (workerOn()) {
      try {
        const w = await getJSON<{ generated_at?: string; events?: AppCal[]; stale?: boolean }>(via("/calendar"), 10000, false);
        if (w.events?.length) {
          apply(w.events, w.generated_at || "", w.stale ? "宏观日历 · Worker 缓存" : "宏观日历 · Worker", !!w.stale || staleOf(w.generated_at));
          return;
        }
      } catch { /* 再试源站 */ }
    }
    if (data.events?.length) {
      apply(data.events, data.generated_at || "", "宏观日历 · 仓库", true);
      return;
    }
  } catch { /* 再试 Worker / 源站 */ }
  if (workerOn()) {
    try {
      const w = await getJSON<{ generated_at?: string; events?: AppCal[]; stale?: boolean }>(via("/calendar"), 10000, false);
      if (w.events?.length) {
        apply(w.events, w.generated_at || "", w.stale ? "宏观日历 · Worker 缓存" : "宏观日历 · Worker", !!w.stale);
        return;
      }
      const evs = await getJSON<AppCal[]>(via("https://nfs.faireconomy.media/ff_calendar_thisweek.json"), 12000, false);
      const events = Array.isArray(evs) ? evs : [];
      if (events.length) {
        apply(events, new Date().toISOString(), "宏观日历 · Worker");
        return;
      }
    } catch { /* fall through */ }
  }
  patch({ calendar: [], calendarAt: "" });
  setStamp("cal", workerOn() ? "日历暂不可用（源站可能限流）" : "日历文件不可用", true);
}

export async function refreshNews() {
  // 有 Worker 时拉中文资讯 RSS；否则明确降级
  if (workerOn()) {
    try {
      const data = await getJSON<{ items?: { title: string; url: string; source: string; t: number }[] }>(
        via("/news/zh"), 12000, false
      );
      if (data.items?.length) {
        patch({ news: data.items, newsNote: "" });
        setStamp("news", "中文资讯 · Worker");
        return;
      }
    } catch { /* fall through */ }
  }
  patch({
    news: [],
    newsNote: workerOn()
      ? "中文资讯暂不可用（Worker 未返回数据）"
      : "浏览器无法直接跨域读取中文资讯源。部署 Cloudflare Worker 并在设置中填写地址后即可显示。",
  });
  setStamp("news", workerOn() ? "资讯失败" : "需 Worker", !workerOn());
}

export async function probeWorker() {
  const w = getState().workerUrl;
  if (!w) { patch({ workerOk: null }); return; }
  try {
    const r = await getJSON<{ ok?: boolean }>(w.replace(/\/$/, "") + "/health", 8000);
    patch({ workerOk: !!r && r.ok !== false });
  } catch {
    patch({ workerOk: false });
  }
}
