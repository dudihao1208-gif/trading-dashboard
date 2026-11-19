import { FAPI_WEB, FAPI_OFFICIAL } from "./klines";
import { getJSON, via, workerOn, toast } from "./store";

export type SymbolRules = {
  symbol: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  maxQty: number;
  minNotional: number; // 交易所规则
  floorNotional: number; // 模拟盘使用的下限（至少 100）
  pricePrecision: number;
  quantityPrecision: number;
  contractType: string;
  status: string;
  maxLeverage: number;
  mmr: number;
  src: string;
  at: number;
};

const mem = new Map<string, SymbolRules>();
const PAPER_MIN_NOTIONAL = 100;

function filterNum(filters: Array<Record<string, string>> | undefined, type: string, key: string, fb = 0) {
  const f = (filters || []).find((x) => x.filterType === type);
  return f ? +(f[key] || 0) || fb : fb;
}

function defaultRules(symbol: string, src = "默认"): SymbolRules {
  const isBtc = symbol.startsWith("BTC");
  return {
    symbol, tickSize: isBtc ? 0.1 : 0.01, stepSize: isBtc ? 0.001 : 0.01,
    minQty: isBtc ? 0.001 : 0.01, maxQty: 1e9,
    minNotional: 5, floorNotional: PAPER_MIN_NOTIONAL,
    pricePrecision: isBtc ? 1 : 2, quantityPrecision: isBtc ? 3 : 2,
    contractType: "PERPETUAL", status: "TRADING",
    maxLeverage: isBtc ? 125 : 50, mmr: isBtc ? 0.004 : 0.01,
    src, at: 0,
  };
}

function fromInfo(symbol: string, raw: Record<string, unknown>, src: string): SymbolRules {
  const filters = (raw.filters || []) as Array<Record<string, string>>;
  const tick = filterNum(filters, "PRICE_FILTER", "tickSize", 0.01);
  const step = filterNum(filters, "LOT_SIZE", "stepSize", 0.001);
  const minQty = filterNum(filters, "LOT_SIZE", "minQty", step);
  const maxQty = filterNum(filters, "LOT_SIZE", "maxQty", 1e9);
  const minNotional = filterNum(filters, "MIN_NOTIONAL", "notional", 5);
  const pp = Number(raw.pricePrecision ?? 2);
  const qp = Number(raw.quantityPrecision ?? 3);
  const isBtc = symbol.startsWith("BTC") || symbol.startsWith("ETH");
  return {
    symbol,
    tickSize: tick || 0.01,
    stepSize: step || 0.001,
    minQty: minQty || step || 0.001,
    maxQty,
    minNotional,
    floorNotional: Math.max(PAPER_MIN_NOTIONAL, minNotional),
    pricePrecision: Number.isFinite(pp) ? pp : 2,
    quantityPrecision: Number.isFinite(qp) ? qp : 3,
    contractType: String(raw.contractType || "PERPETUAL"),
    status: String(raw.status || "TRADING"),
    maxLeverage: isBtc ? 125 : 50,
    mmr: isBtc ? 0.004 : 0.01,
    src,
    at: Date.now(),
  };
}

export async function loadRules(symbol: string, force = false): Promise<SymbolRules> {
  const hit = mem.get(symbol);
  if (!force && hit && Date.now() - hit.at < 6 * 3600_000) return hit;
  const paths = [
    workerOn() ? via(`/exchangeInfo?symbol=${encodeURIComponent(symbol)}`) : "",
    `${FAPI_WEB}/fapi/v1/exchangeInfo`,
    workerOn() ? via(`${FAPI_WEB}/fapi/v1/exchangeInfo`) : "",
    workerOn() ? via(`${FAPI_OFFICIAL}/fapi/v1/exchangeInfo`) : "",
  ].filter(Boolean);
  for (const u of paths) {
    try {
      const data = await getJSON<Record<string, unknown> | { symbols?: Record<string, unknown>[] }>(u, u.includes("exchangeInfo?symbol") ? 10000 : 20000, false);
      let raw: Record<string, unknown> | undefined;
      if (data && (data as { symbol?: string }).symbol === symbol && (data as { filters?: unknown }).filters) {
        raw = data as Record<string, unknown>;
      } else {
        const list = (data as { symbols?: Record<string, unknown>[] }).symbols || [];
        raw = list.find((s) => s.symbol === symbol);
      }
      if (raw) {
        const rules = fromInfo(symbol, raw, u.includes("/proxy") || u.includes("workers.dev") || u.includes("/exchangeInfo?") ? "Worker 缓存" : "币安期货规则");
        mem.set(symbol, rules);
        return rules;
      }
    } catch { /* next */ }
  }
  const fb = defaultRules(symbol, "默认规则（未能加载交易所过滤器）");
  toast("未拿到交易所规则，暂用默认步进/最小额，下单请再核对");
  mem.set(symbol, fb);
  return fb;
}

export function roundToTick(price: number, tick: number, dir: "near" | "up" | "down" = "near"): number {
  if (!tick || !Number.isFinite(price)) return price;
  const n = price / tick;
  const r = dir === "up" ? Math.ceil(n - 1e-12) : dir === "down" ? Math.floor(n + 1e-12) : Math.round(n);
  const x = r * tick;
  const d = tick >= 1 ? 0 : Math.min(8, (String(tick).split(".")[1] || "").length);
  return +x.toFixed(d);
}

export function roundQty(qty: number, step: number): number {
  if (!step || !Number.isFinite(qty)) return qty;
  const d = step >= 1 ? 0 : Math.min(8, (String(step).split(".")[1] || "").length);
  return +(Math.floor(qty / step + 1e-12) * step).toFixed(d);
}

export function qtyDecimals(step: number) {
  return step >= 1 ? 0 : Math.min(8, (String(step).split(".")[1] || "").length);
}

export function priceDecimals(tick: number) {
  return tick >= 1 ? 0 : Math.min(8, (String(tick).split(".")[1] || "").length);
}
