import { isAllowedOrigin, type Env } from "./index";
import { sendTelegram } from "./monitor";
import { formatRome } from "./news";

export type UserAlert = {
  id: string;
  symbol: string;
  kind: "above" | "below" | "chgUp" | "chgDown";
  value: number;
  persist: "once" | "repeat";
  enabled: boolean;
  createdAt: number;
  refPrice?: number;
  lastFired?: number;
  note?: string;
};

const USER_TTL = 180 * 24 * 3600;
const PAIR_TTL = 10 * 60;
const FAPI_WEB = "https://www.binance.com";
const UA = "Mozilla/5.0 (compatible; trading-dashboard-proxy/2.1)";

function jsonTok() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function pairCode() {
  return String(100000 + Math.floor(Math.random() * 900000));
}

async function userOf(env: Env, token: string) {
  if (!token) return null;
  const raw = await env.STATE.get("alert-user:" + token);
  if (!raw) return null;
  try { return JSON.parse(raw) as { token: string; linked: boolean }; } catch { return null; }
}

export function bearer(req: Request) {
  const h = req.headers.get("Authorization") || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}

export async function handleAlerts(req: Request, env: Env, path: string, url: URL): Promise<Response | null> {
  if (!path.startsWith("/alerts")) return null;
  const out = (data: unknown, status = 200) => {
    const origin = req.headers.get("Origin") || "";
    const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
    if (isAllowedOrigin(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
      headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
      headers.Vary = "Origin";
    }
    return new Response(JSON.stringify(data), { status, headers });
  };

  if (path === "/alerts/pair" && req.method === "POST") {
    const code = pairCode();
    await env.STATE.put("alert-pair:" + code, JSON.stringify({ at: Date.now() }), { expirationTtl: PAIR_TTL });
    const ok = await sendTelegram(env, `观察台价格提醒配对码：${code}\n10 分钟内在「我的 → 预警」输入即可绑定。这不是行情提醒。`);
    if (!ok) return out({ error: "无法发送 Telegram，请检查机器人配置" }, 502);
    return out({ ok: true });
  }

  if (path === "/alerts/confirm" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { code?: string };
    const code = String(body.code || "").trim();
    const raw = code ? await env.STATE.get("alert-pair:" + code) : null;
    if (!raw) return out({ error: "配对码无效或已过期" }, 400);
    const token = jsonTok();
    await env.STATE.put("alert-user:" + token, JSON.stringify({ token, linked: true, at: Date.now() }), { expirationTtl: USER_TTL });
    await env.STATE.put("alerts:" + token, JSON.stringify({ items: [] as UserAlert[] }), { expirationTtl: USER_TTL });
    await env.STATE.delete("alert-pair:" + code);
    return out({ ok: true, token });
  }

  const token = bearer(req);
  const user = await userOf(env, token);
  if (!user?.linked) return out({ error: "请先绑定 Telegram 配对码" }, 401);

  if (path === "/alerts/test" && req.method === "POST") {
    const ok = await sendTelegram(env, `【测试】价格提醒通道已接通\n时间：${formatRome(Date.now())}\n这是一条测试消息，不是真实的价格触发。`);
    return out({ ok, sent: ok });
  }

  if (path === "/alerts" && req.method === "GET") {
    const pack = await readItems(env, token);
    return out({ items: pack.items });
  }

  if (path === "/alerts" && req.method === "POST") {
    const body = await req.json() as Partial<UserAlert>;
    const symbol = String(body.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!symbol.endsWith("USDT")) return out({ error: "请使用 USDT 交易对，例如 BTCUSDT" }, 400);
    if (!["above", "below", "chgUp", "chgDown"].includes(String(body.kind))) return out({ error: "提醒类型无效" }, 400);
    const value = Number(body.value);
    if (!Number.isFinite(value) || value <= 0) return out({ error: "请填写有效阈值" }, 400);
    const pack = await readItems(env, token);
    const id = body.id && pack.items.some((x) => x.id === body.id) ? body.id : "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const next: UserAlert = {
      id, symbol, kind: body.kind as UserAlert["kind"], value,
      persist: body.persist === "repeat" ? "repeat" : "once",
      enabled: body.enabled !== false,
      createdAt: pack.items.find((x) => x.id === id)?.createdAt || Date.now(),
      refPrice: Number(body.refPrice) || pack.items.find((x) => x.id === id)?.refPrice,
      lastFired: pack.items.find((x) => x.id === id)?.lastFired,
    };
    pack.items = [next, ...pack.items.filter((x) => x.id !== id)];
    await writeItems(env, token, pack.items);
    return out({ items: pack.items });
  }

  if (path === "/alerts" && req.method === "DELETE") {
    const id = url.searchParams.get("id") || "";
    const pack = await readItems(env, token);
    pack.items = pack.items.filter((x) => x.id !== id);
    await writeItems(env, token, pack.items);
    return out({ items: pack.items });
  }

  void url;
  return out({ error: "method" }, 405);
}

async function readItems(env: Env, token: string) {
  const raw = await env.STATE.get("alerts:" + token);
  try { return raw ? JSON.parse(raw) as { items: UserAlert[] } : { items: [] as UserAlert[] }; }
  catch { return { items: [] as UserAlert[] }; }
}
async function writeItems(env: Env, token: string, items: UserAlert[]) {
  await env.STATE.put("alerts:" + token, JSON.stringify({ items }), { expirationTtl: USER_TTL });
}

type Px = { mark: number; last: number; chg: number };

async function loadPrices(symbols: string[]): Promise<Record<string, Px>> {
  const out: Record<string, Px> = {};
  if (!symbols.length) return out;
  try {
    const r = await fetch(`${FAPI_WEB}/fapi/v1/premiumIndex`, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (r.ok) {
      const rows = await r.json() as { symbol: string; markPrice: string }[];
      if (Array.isArray(rows)) {
        const want = new Set(symbols);
        for (const row of rows) {
          if (!want.has(row.symbol)) continue;
          const mark = +row.markPrice;
          if (mark) out[row.symbol] = { mark, last: mark, chg: 0 };
        }
      }
    }
  } catch { /* */ }
  const missing = symbols.filter((s) => !out[s]);
  // 24h 涨跌用 Vision 现货近似；标记价优先用上面的期货数据
  try {
    const r = await fetch("https://data-api.binance.vision/api/v3/ticker/24hr", { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (r.ok) {
      const rows = await r.json() as { symbol: string; lastPrice: string; priceChangePercent: string }[];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!symbols.includes(row.symbol)) continue;
        const last = +row.lastPrice, chg = +row.priceChangePercent;
        if (!out[row.symbol] && last) out[row.symbol] = { mark: last, last, chg };
        else if (out[row.symbol]) { out[row.symbol].last = last || out[row.symbol].last; out[row.symbol].chg = chg; }
      }
    }
  } catch { /* */ }
  for (const s of missing) {
    if (out[s]) continue;
    try {
      const r = await fetch(`https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=${s.replace("USDT", "-USDT-SWAP")}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
      const d = await r.json() as { code?: string; data?: { markPx: string }[] };
      const mark = d.code === "0" && d.data?.[0] ? +d.data[0].markPx : 0;
      if (mark) out[s] = { mark, last: mark, chg: 0 };
    } catch { /* */ }
  }
  return out;
}

function triggered(a: UserAlert, px: Px) {
  const mark = px.mark;
  if (a.kind === "above") return mark >= a.value;
  if (a.kind === "below") return mark <= a.value;
  const ref = a.refPrice || 0;
  if (a.kind === "chgUp") {
    if (ref) return ((mark / ref) - 1) * 100 >= a.value;
    return px.chg >= a.value;
  }
  if (a.kind === "chgDown") {
    if (ref) return (1 - mark / ref) * 100 >= a.value;
    return px.chg <= -a.value;
  }
  return false;
}

function describe(a: UserAlert, px: Px) {
  const kind = a.kind === "above" ? "涨到" : a.kind === "below" ? "跌到" : a.kind === "chgUp" ? "涨幅达到" : "跌幅达到";
  const th = a.kind.startsWith("chg") ? `${a.value}%` : String(a.value);
  return `${a.symbol} ${kind} ${th}\n标记价 ${px.mark}（参考价 ${px.last}）`;
}

/** 每分钟检查已绑定用户的价格提醒。价格来源：www.binance.com 标记价（美国可访问），其次 Vision / OKX。 */
export async function runAlertCron(env: Env) {
  const list = await env.STATE.list({ prefix: "alerts:" });
  const tokens = list.keys.map((k) => k.name.slice("alerts:".length)).filter(Boolean);
  if (!tokens.length) return { checked: 0, sent: 0 };
  const allItems: { token: string; items: UserAlert[] }[] = [];
  const symbols = new Set<string>();
  for (const token of tokens) {
    const pack = await readItems(env, token);
    allItems.push({ token, items: pack.items });
    for (const it of pack.items) if (it.enabled) symbols.add(it.symbol);
  }
  const prices = await loadPrices([...symbols]);
  let sent = 0;
  for (const { token, items } of allItems) {
    let changed = false;
    const lines: string[] = [];
    for (const a of items) {
      if (!a.enabled) continue;
      const px = prices[a.symbol];
      if (!px) continue;
      if (a.lastFired && Date.now() - a.lastFired < (a.persist === "repeat" ? 10 * 60_000 : 1)) continue;
      if (!triggered(a, px)) continue;
      a.lastFired = Date.now();
      if (a.persist === "once") a.enabled = false;
      changed = true;
      lines.push(describe(a, px));
    }
    if (lines.length) {
      const body = "📡 价格提醒\n" + formatRome(Date.now()) + "\n\n" + lines.join("\n\n") + "\n\n本提醒仅供观察，不构成投资建议。";
      const ok = await sendTelegram(env, body);
      if (ok) sent += lines.length;
    }
    if (changed) await writeItems(env, token, items);
  }
  return { checked: symbols.size, sent };
}

export async function handleExchangeInfo(env: Env, symbol: string) {
  const key = "exinfo:v1";
  let raw = await env.STATE.get(key);
  if (!raw) {
    const r = await fetch(`${FAPI_WEB}/fapi/v1/exchangeInfo`, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!r.ok) throw new Error("exchangeInfo HTTP " + r.status);
    raw = await r.text();
    await env.STATE.put(key, raw, { expirationTtl: 24 * 3600 });
  }
  const data = JSON.parse(raw) as { symbols?: Record<string, unknown>[] };
  if (symbol) {
    const one = (data.symbols || []).find((s) => s.symbol === symbol);
    if (!one) throw new Error("unknown symbol");
    return one;
  }
  return { count: (data.symbols || []).length };
}
