/** 代币化美股 → 正股代码。未列入白名单的丢弃，避免 KRAQX/W 前缀等误映射。 */
const XSPECIAL: Record<string, string | null> = {
  SPCX: null, STRCX: null, CRCLX: "CRCL", SNDKX: "SNDK",
  SPYX: "SPY", QQQX: "QQQ", GOOGLX: "GOOGL",
};

const KNOWN = new Set([
  "AAPL","ABT","ADBE","AMD","AMZN","ARM","AVGO","AMC","BA","BABA","BAC","COIN",
  "COST","CRM","CRCL","CRWD","DIS","GME","GOOG","GOOGL","GS","HD","HOOD","IBM",
  "INTC","JNJ","JPM","KO","LLY","MA","META","MSFT","MSTR","MRVL","NFLX","NKE",
  "NVDA","ORCL","PLTR","PYPL","QCOM","SHOP","SMCI","SNDK","TSM","TSLA","UNH",
  "V","WMT","XOM","SPY","QQQ","IWM","DIA","VOO","IVV","TQQQ","SQQQ","SOXL",
  "SOXS","QQQM",
]);

export const PREMIUM_CAP = 30;

export function underlyingOf(xsym: string): string | null {
  const raw = (xsym || "").toUpperCase().replace(/[^A-Z0-9.]/g, "");
  if (!raw) return null;
  if (raw in XSPECIAL) return XSPECIAL[raw];
  let core = raw.endsWith("X") && raw.length >= 3 ? raw.slice(0, -1) : raw;
  if (core.startsWith("W") && core.length >= 3 && KNOWN.has(core.slice(1))) core = core.slice(1);
  if (KNOWN.has(core)) return core;
  return null;
}

export function sanePremium(tok: number, under: number): number | null {
  if (!tok || !under) return null;
  const p = (tok / under - 1) * 100;
  if (!Number.isFinite(p) || Math.abs(p) > PREMIUM_CAP) return null;
  return p;
}
