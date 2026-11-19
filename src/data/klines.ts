import { parseKlines, type Candle } from "../lib/indicators";
import { firstOK, getJSON, via, workerOn, SPOT_REST } from "./store";

/** 官方 fapi.binance.com 在美国 IP 常 451，且无浏览器 CORS。www.binance.com/fapi 可从美国访问且 ACAO=*。 */
export const FAPI_WEB = "https://www.binance.com";
export const FAPI_OFFICIAL = "https://fapi.binance.com";

export type KlineSource = "futures-last" | "futures-mark" | "spot";

export type KlinePack = {
  bars: Candle[];
  source: KlineSource;
  base: string;
  /** 已拉完全部可得历史，且根数足够计算指标时为 true */
  ready: boolean;
  note: string;
};

const MAX_PAGES = 6;
const PAGE = 1500;
const WANT = 1500; // 至少拉这么多（或直到没有更早的）
const MIN_INDICATOR_BARS = 200;

function qs(symbol: string, interval: string, extra: Record<string, string | number> = {}) {
  const p = new URLSearchParams({ symbol, interval, limit: String(PAGE), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) });
  return p.toString();
}

async function getRows(urls: string[], timeout = 15000): Promise<{ base: string; rows: (string | number)[][] } | null> {
  for (const u of urls) {
    try {
      const data = await getJSON<(string | number)[][] | { msg?: string; code?: number }>(u, timeout, false);
      if (Array.isArray(data) && data.length) return { base: new URL(u).origin, rows: data };
    } catch { /* next */ }
  }
  return null;
}

function futUrls(path: string, query: string): string[] {
  const direct = `${FAPI_WEB}${path}?${query}`;
  const official = `${FAPI_OFFICIAL}${path}?${query}`;
  const list = [direct];
  if (workerOn()) {
    list.push(via(direct), via(official));
  }
  return list;
}

async function paginate(path: string, symbol: string, interval: string, kind: "fut" | "spot"): Promise<{ base: string; rows: (string | number)[][] }> {
  const all: (string | number)[][] = [];
  let end: number | undefined;
  let base = "";
  for (let page = 0; page < MAX_PAGES && all.length < WANT * 2; page++) {
    const extra: Record<string, string | number> = end ? { endTime: end - 1 } : {};
    const query = qs(symbol, interval, extra);
    const pack = kind === "fut"
      ? await getRows(futUrls(path, query))
      : await firstOK<(string | number)[][]>(SPOT_REST, `/api/v3/klines?${query}`, 15000).then((r) => ({ base: r.base, rows: r.data })).catch(() => null);
    if (!pack?.rows?.length) break;
    base = pack.base;
    const rows = pack.rows;
    all.unshift(...rows);
    const first = Number(rows[0][0]);
    if (!Number.isFinite(first) || first === end) break;
    end = first;
    if (rows.length < PAGE * 0.9) break;
  }
  // 去重
  const map = new Map<number, (string | number)[]>();
  for (const r of all) map.set(Number(r[0]), r);
  return { base, rows: [...map.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]) };
}

/**
 * 期货优先用成交价 K 线；若合约上线不久、根数不够算 EMA/BOLL，则改用更长的标记价格 K 线（与币安 App 一致，例如 ANTUSDT）。
 * 现货走 Vision。全部按页向回补齐真实历史，绝不估算指标。
 */
export async function loadKlines(symbol: string, interval: string): Promise<KlinePack> {
  // 先尝试期货成交价
  try {
    const last = await paginate("/fapi/v1/klines", symbol, interval, "fut");
    if (last.rows.length >= MIN_INDICATOR_BARS) {
      const bars = parseKlines(last.rows);
      return { bars, source: "futures-last", base: last.base, ready: bars.length >= MIN_INDICATOR_BARS, note: `币安期货成交价 · ${bars.length} 根` };
    }
    const mark = await paginate("/fapi/v1/markPriceKlines", symbol, interval, "fut");
    if (mark.rows.length > last.rows.length) {
      const bars = parseKlines(mark.rows);
      const ready = bars.length >= 50; // 至少够 EMA50
      return { bars, source: "futures-mark", base: mark.base, ready, note: `币安期货标记价格 · ${bars.length} 根（合约成交价仅 ${last.rows.length} 根，不足以计算均线）` };
    }
    if (last.rows.length) {
      const bars = parseKlines(last.rows);
      return { bars, source: "futures-last", base: last.base, ready: false, note: `币安期货成交价 · 仅 ${bars.length} 根，均线暂不显示` };
    }
  } catch { /* 试现货 */ }

  const spot = await paginate("/api/v3/klines", symbol, interval, "spot");
  const bars = parseKlines(spot.rows);
  return {
    bars,
    source: "spot",
    base: spot.base || "vision",
    ready: bars.length >= MIN_INDICATOR_BARS,
    note: bars.length ? `币安现货 · ${bars.length} 根` : "K 线加载失败",
  };
}

export async function fetchLastFutKline(symbol: string, interval: string, mark: boolean): Promise<Candle | null> {
  const path = mark ? "/fapi/v1/markPriceKlines" : "/fapi/v1/klines";
  const pack = await getRows(futUrls(path, qs(symbol, interval, { limit: 2 })), 8000);
  if (!pack?.rows?.length) return null;
  const bars = parseKlines(pack.rows);
  return bars[bars.length - 1] || null;
}

export async function fetchMarkPrice(symbol: string): Promise<{ mark: number; index?: number; last?: number; rate?: number; next?: number } | null> {
  const urls = futUrls("/fapi/v1/premiumIndex", `symbol=${encodeURIComponent(symbol)}`);
  for (const u of urls) {
    try {
      const d = await getJSON<{ markPrice?: string; indexPrice?: string; lastFundingRate?: string; nextFundingTime?: number; symbol?: string }>(u, 8000, false);
      const mark = +(d.markPrice || 0);
      if (mark) return { mark, index: +(d.indexPrice || 0), rate: +(d.lastFundingRate || 0), next: d.nextFundingTime };
    } catch { /* next */ }
  }
  return null;
}

export async function fetchFutDepth(symbol: string, limit = 20): Promise<{ bids: { p: number; q: number }[]; asks: { p: number; q: number }[]; src: string } | null> {
  const urls = futUrls("/fapi/v1/depth", `symbol=${encodeURIComponent(symbol)}&limit=${limit}`);
  for (const u of urls) {
    try {
      const d = await getJSON<{ bids?: string[][]; asks?: string[][] }>(u, 8000, false);
      if (d.bids && d.asks) {
        return {
          bids: d.bids.map(([p, q]) => ({ p: +p, q: +q })),
          asks: d.asks.map(([p, q]) => ({ p: +p, q: +q })),
          src: "币安期货盘口",
        };
      }
    } catch { /* next */ }
  }
  return null;
}
