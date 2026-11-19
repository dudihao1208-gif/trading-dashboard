import { fmtPrice, fmtPct, fmtUsd, fmtCountdown } from "../lib/format";

export const MAJORS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
export const LS_KEY = "trading-obs-v2";
export const BASE = import.meta.env.BASE_URL || "/";

export const SPOT_REST = ["https://data-api.binance.vision", "https://api.binance.com"];
export const SPOT_WS = [
  "wss://data-stream.binance.vision/ws",
  "wss://stream.binance.com:9443/ws",
];
export const FUT_WS = ["wss://fstream.binance.com/stream?streams="];
export const FAPI = ["https://fapi.binance.com"];
export const OKX = "https://www.okx.com";
export const FNG = "https://api.alternative.me/fng/?limit=1";
export const CG_GLOBAL = "https://api.coingecko.com/api/v3/global";
export const CG_XSTOCKS =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=xstocks-ecosystem&order=market_cap_desc&per_page=40&page=1&price_change_percentage=24h";
export const CG_DERIV = "https://api.coingecko.com/api/v3/derivatives";
export const LEV_RE = /(UP|DOWN|BULL|BEAR|3L|3S|5L|5S)USDT$/;

export type LinkState = "idle" | "wait" | "live" | "rest" | "down";

export type Ticker = {
  c: number; o: number; h?: number; l?: number; q?: number; v?: number;
  chg: number; t: number; src: "ws" | "rest";
};

export type Funding = { rate: number; source: string; t: number; mark?: number; next?: number; oiUsd?: number };
export type Signal = {
  id: string; kind: string; title: string; detail: string; symbol: string;
  hot?: boolean; t: number;
};
export type AlertRule = { symbol: string; above: number | null; below: number | null };
export type BookLevel = { p: number; q: number };
export type Trade = { t: number; p: number; q: number; m: boolean };

export type XStock = {
  id: string; symbol: string; name: string; price: number; chg: number;
  under?: { symbol: string; price: number; chg: number | null; name?: string } | null;
  premium: number | null; corr: number | null; noUnder?: boolean;
};

type Snap = { t: number; p: number; q: number };

export type AppState = {
  tickers: Record<string, Ticker>;
  snaps: Record<string, Snap[]>;
  funding: Record<string, Funding>;
  oi: Record<string, { instId: string; oiUsd: number }>;
  macros: { mcap?: number; dom?: number; vol?: number; fng?: number; fngClass?: string };
  watch: string[];
  alerts: Record<string, AlertRule>;
  alertLog: { t: number; msg: string }[];
  fired: Record<string, number>;
  signals: Signal[];
  liqs: { t: number; s: string; side: string; px: number; usd: number }[];
  xstocks: XStock[];
  calendar: { title: string; country: string; date: string; impact: string; forecast: string; previous: string }[];
  calendarAt: string;
  news: { title: string; url: string; source: string; t: number }[];
  newsNote: string;
  book: { bids: BookLevel[]; asks: BookLevel[] };
  trades: Trade[];
  symbol: string;
  tf: string;
  tab: string;
  phone: boolean;
  multi: boolean;
  workerUrl: string;
  workerOk: boolean | null;
  spot: { state: LinkState; label: string; detail: string };
  fut: { state: LinkState; label: string; detail: string };
  stamps: Record<string, { text: string; err?: boolean }>;
  toasts: { id: number; msg: string }[];
};

const listeners = new Set<() => void>();

function loadLS(): Partial<AppState> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const d = JSON.parse(raw);
    return {
      watch: Array.isArray(d.watch) && d.watch.length ? d.watch : undefined,
      alerts: d.alerts,
      alertLog: d.alertLog,
      symbol: d.symbol,
      tf: d.tf,
      workerUrl: d.workerUrl,
    };
  } catch {
    return {};
  }
}

const ls = loadLS();

let state: AppState = {
  tickers: {},
  snaps: {},
  funding: {},
  oi: {},
  macros: {},
  watch: ls.watch || [...MAJORS.slice(0, 4)],
  alerts: ls.alerts || {},
  alertLog: ls.alertLog || [],
  fired: {},
  signals: [],
  liqs: [],
  xstocks: [],
  calendar: [],
  calendarAt: "",
  news: [],
  newsNote: "",
  book: { bids: [], asks: [] },
  trades: [],
  symbol: ls.symbol || "BTCUSDT",
  tf: ls.tf || "1h",
  tab: "market",
  phone: typeof window !== "undefined" ? window.innerWidth < 960 : true,
  multi: false,
  workerUrl: (typeof ls.workerUrl === "string" ? ls.workerUrl : (import.meta.env.VITE_WORKER_URL || "")).replace(/\/$/, ""),
  workerOk: null,
  spot: { state: "idle", label: "现货未连接", detail: "" },
  fut: { state: "idle", label: "期货未连接", detail: "" },
  stamps: {},
  toasts: [],
};

export function getState() { return state; }
export function subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { listeners.forEach((f) => f()); }

export function patch(p: Partial<AppState>) {
  state = { ...state, ...p };
  emit();
}

export function saveLS() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      watch: state.watch, alerts: state.alerts, alertLog: state.alertLog.slice(0, 40),
      symbol: state.symbol, tf: state.tf, workerUrl: state.workerUrl,
    }));
  } catch { /* quota */ }
}

export function setStamp(k: string, text: string, err = false) {
  state = { ...state, stamps: { ...state.stamps, [k]: { text, err } } };
  emit();
}

export function stampOf(k: string, fallback = "") {
  return state.stamps[k]?.text || fallback;
}

export function toast(msg: string) {
  const id = Date.now() + Math.random();
  state = { ...state, toasts: [...state.toasts, { id, msg }].slice(-5) };
  emit();
  setTimeout(() => {
    state = { ...state, toasts: state.toasts.filter((t) => t.id !== id) };
    emit();
  }, 5000);
}

export function workerOn(): boolean {
  return !!state.workerUrl;
}

/** 经 Worker 代理；以 / 开头的路径（如 /news/zh）走 Worker 自身路由，其余走白名单代理。 */
export function via(url: string): string {
  const w = state.workerUrl;
  if (!w) return url;
  const root = w.replace(/\/$/, "");
  if (url.startsWith("/")) return root + url;
  if (url.startsWith(root)) return url;
  return root + "/proxy?url=" + encodeURIComponent(url);
}

export async function getJSON<T = unknown>(url: string, timeout = 12000, useWorker = false): Promise<T> {
  const target = useWorker ? via(url) : url;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(target, { signal: ctl.signal });
    if (!res.ok) {
      const err = new Error("HTTP " + res.status) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return await res.json() as T;
  } finally {
    clearTimeout(t);
  }
}

export async function firstOK<T>(bases: string[], path: string, timeout = 8000, tryWorker = false): Promise<{ base: string; data: T }> {
  let last: unknown;
  const list = tryWorker && state.workerUrl ? [...bases] : bases;
  // vision first already in bases
  for (const base of list) {
    try {
      const data = await getJSON<T>(base + path, timeout, false);
      return { base, data };
    } catch (e) {
      last = e;
    }
  }
  if (tryWorker && state.workerUrl) {
    try {
      const data = await getJSON<T>(bases[bases.length - 1] + path, timeout, true);
      return { base: "worker", data };
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error("全部失败");
}

export function upsertTicker(sym: string, rec: Partial<Ticker> & { c: number }) {
  const prev = state.tickers[sym] || { c: rec.c, o: rec.c, chg: 0, t: 0, src: "rest" as const };
  const next: Ticker = {
    ...prev,
    ...rec,
    t: rec.t || Date.now(),
    chg: rec.chg != null ? rec.chg : rec.o ? ((rec.c / rec.o) - 1) * 100 : prev.chg,
  };
  state.tickers = { ...state.tickers, [sym]: next };
  // snapshots for radar (keep ~1h)
  const now = next.t;
  const arr = (state.snaps[sym] || []).filter((s) => now - s.t < 70 * 60 * 1000);
  const last = arr[arr.length - 1];
  if (!last || now - last.t >= 5000) {
    arr.push({ t: now, p: next.c, q: next.q || 0 });
    state.snaps = { ...state.snaps, [sym]: arr.slice(-900) };
  }
  checkAlerts(sym, next);
  emit();
  return next;
}

function cooled(key: string, ms: number) {
  const t = state.fired[key];
  return t != null && Date.now() - t < ms;
}
function markFired(key: string) {
  state.fired = { ...state.fired, [key]: Date.now() };
}

export function pushAlert(msg: string, symbol = "", kind = "alert") {
  state.alertLog = [{ t: Date.now(), msg }, ...state.alertLog].slice(0, 40);
  saveLS();
  toast(msg);
  addSignal({
    id: "alert-" + Date.now(),
    kind,
    title: msg,
    detail: "",
    symbol,
    t: Date.now(),
    hot: true,
  });
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("交易观察台", { body: msg, icon: BASE + "icons/icon-192.png" });
    }
  } catch { /* iOS */ }
}

export function addSignal(s: Signal) {
  if (state.signals.some((x) => x.id === s.id)) return;
  state.signals = [s, ...state.signals].slice(0, 80);
  emit();
}

function checkAlerts(sym: string, t: Ticker) {
  const a = state.alerts[sym];
  if (!a || t.c == null) return;
  if (a.above != null && t.c >= a.above) {
    const key = `${sym}:above:${a.above}`;
    if (!cooled(key, 5 * 60 * 1000)) {
      markFired(key);
      pushAlert(`⬆️ ${sym} 现价 ${fmtPrice(t.c)} 突破 ${fmtPrice(a.above)}`, sym, "突破");
    }
  }
  if (a.below != null && t.c <= a.below) {
    const key = `${sym}:below:${a.below}`;
    if (!cooled(key, 5 * 60 * 1000)) {
      markFired(key);
      pushAlert(`⬇️ ${sym} 现价 ${fmtPrice(t.c)} 跌破 ${fmtPrice(a.below)}`, sym, "跌破");
    }
  }
}

export function dashboardLink(symbol: string) {
  const origin = import.meta.env.VITE_DASHBOARD_URL || (typeof location !== "undefined" ? location.origin + BASE : "");
  const base = origin.endsWith("/") ? origin : origin + "/";
  return `${base}?tab=chart&symbol=${encodeURIComponent(symbol)}`;
}

export function nextFundingTime(from = Date.now()) {
  // 币安/OKX 常见 00:00/08:00/16:00 UTC
  const d = new Date(from);
  const utcH = d.getUTCHours();
  const slots = [0, 8, 16, 24];
  let add = slots.find((h) => h > utcH || (h === utcH && (d.getUTCMinutes() > 0 || d.getUTCSeconds() > 0))) ?? 24;
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), add === 24 ? 24 : add, 0, 0));
  return n.getTime();
}

export function instOf(sym: string) {
  if (sym.endsWith("USDT")) return sym.slice(0, -4) + "-USDT-SWAP";
  return sym + "-SWAP";
}

export { fmtPrice, fmtPct, fmtUsd, fmtCountdown };
