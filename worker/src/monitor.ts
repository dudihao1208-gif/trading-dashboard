import { collectNews, type NewsItem } from "./news";
import { translateNews, formatNewsTelegram } from "./translate";
import { evaluateNews, storyKey } from "./score";
import type { Env } from "./index";

const VISION = "https://data-api.binance.vision";
const OKX = "https://www.okx.com";
const FF = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const UA = "Mozilla/5.0 (compatible; trading-dashboard-proxy/2.1)";
const MAJORS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
const LEV = /(UP|DOWN|BULL|BEAR|3L|3S|5L|5S)USDT$/;
const MIN_QUOTE = 50_000_000;
const SCAN_CAP = 40;
const VOL_CAP = 8;
const FUND_CAP = 8;
const FUND_TH = 0.001;
const VOL_RATIO = 5;
const OI_SURGE = 10;
const COOL_MIN = 480; // 机会类：同一标的 8 小时冷却
const MAX_TOTAL = 3;
const MAX_NEWS = 2;
const EQUITY_DEFAULT = ["AAPL","NVDA","TSLA","GOOGL","AMZN","MSFT","META","SPY","QQQ","MSTR","COIN","INTC","AMD","CRCL","SNDK","PLTR"];

export type MonitorState = {
  alerts: Record<string, number>;
  oi_usd: Record<string, number>;
};

export type LastRun = {
  at: string;
  atRome: string;
  trigger: string;
  ok: boolean;
  sent: number;
  scanned: number;
  skipped?: string;
  error?: string;
  sources?: string[];
  preview?: string[];
};

function rome(isoOrNow?: number) {
  const d = new Date(isoOrNow ?? Date.now());
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Rome",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  return fmt.format(d).replace("T", " ") + " (欧洲/Rome)";
}

function iso() { return new Date().toISOString(); }

async function jfetch<T>(url: string, timeout = 10000): Promise<T | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json() as T;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function loadMonitorState(env: Env): Promise<MonitorState> {
  try {
    const raw = await env.STATE.get("monitor-state");
    const d = raw ? JSON.parse(raw) as Partial<MonitorState> : {};
    return { alerts: d.alerts || {}, oi_usd: d.oi_usd || {} };
  } catch {
    return { alerts: {}, oi_usd: {} };
  }
}

export async function saveMonitorState(env: Env, state: MonitorState) {
  await env.STATE.put("monitor-state", JSON.stringify(state));
}

export async function writeLastRun(env: Env, run: LastRun) {
  await env.STATE.put("lastRun", JSON.stringify(run));
}

export async function readLastRun(env: Env): Promise<LastRun | null> {
  try {
    const raw = await env.STATE.get("lastRun");
    return raw ? JSON.parse(raw) as LastRun : null;
  } catch { return null; }
}

function cooled(state: MonitorState, key: string, minutes: number) {
  const last = state.alerts[key];
  if (!last) return false;
  return (Date.now() / 1000 - last) < minutes * 60;
}
function mark(state: MonitorState, key: string) {
  state.alerts[key] = Date.now() / 1000;
}

function okxNext(row: { fundingTime?: string; nextFundingTime?: string }) {
  const now = Date.now();
  const ft = row.fundingTime ? +row.fundingTime : 0;
  const nft = row.nextFundingTime ? +row.nextFundingTime : 0;
  if (ft > now + 30_000) return ft;
  if (nft > now + 30_000) return nft;
  return 0;
}

function instOf(sym: string) {
  return sym.endsWith("USDT") ? sym.slice(0, -4) + "-USDT-SWAP" : sym + "-SWAP";
}

type Ticker = { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string };

async function refreshCalendarKv(env: Env, force = false) {
  const raw = await env.STATE.get("calendar");
  let cached: { generated_at?: string; events?: unknown[]; stale?: boolean; error?: string } | null = null;
  try { cached = raw ? JSON.parse(raw) : null; } catch { cached = null; }
  const age = cached?.generated_at ? Date.now() - Date.parse(cached.generated_at) : Infinity;
  if (!force && cached?.events?.length && age < 3 * 3600_000) return cached;
  const evs = await jfetch<unknown[]>(FF, 12000);
  if (Array.isArray(evs) && evs.length) {
    const pack = { generated_at: iso(), source: FF, events: evs, stale: false };
    await env.STATE.put("calendar", JSON.stringify(pack));
    return pack;
  }
  if (cached?.events?.length) {
    const pack = { ...cached, stale: true };
    await env.STATE.put("calendar", JSON.stringify(pack));
    return pack;
  }
  const pack = { generated_at: cached?.generated_at || "", events: [], stale: true, error: "Forex Factory 暂不可用（可能 429）" };
  return pack;
}

async function refreshEquitiesKv(env: Env, extra: string[] = [], force = false) {
  const raw = await env.STATE.get("equities");
  let cached: { generated_at?: string; quotes?: Record<string, { price: number; change_percent: number | null; name?: string }> } | null = null;
  try { cached = raw ? JSON.parse(raw) : null; } catch { cached = null; }
  const age = cached?.generated_at ? Date.now() - Date.parse(cached.generated_at) : Infinity;
  if (!force && cached && Object.keys(cached.quotes || {}).length && age < 3 * 3600_000) return cached;
  const want = Array.from(new Set([...EQUITY_DEFAULT, ...extra]));
  const quotes: Record<string, { price: number; change_percent: number | null; name?: string }> = { ...(cached?.quotes || {}) };
  const chunk = want.slice(0, 24);
  await Promise.all(chunk.map(async (sym) => {
    const data = await jfetch<{
      chart?: { result?: Array<{
        meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number; shortName?: string };
      }> };
    }>(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`, 10000);
    const meta = data?.chart?.result?.[0]?.meta;
    const last = meta?.regularMarketPrice;
    const prev = meta?.chartPreviousClose || meta?.previousClose;
    if (last) {
      quotes[sym] = {
        price: last,
        change_percent: prev ? (last / prev - 1) * 100 : null,
        name: meta?.shortName || sym,
      };
    }
  }));
  const pack = { generated_at: iso(), quotes };
  await env.STATE.put("equities", JSON.stringify(pack));
  return pack;
}

export async function getCalendar(env: Env) { return refreshCalendarKv(env, false); }
export async function getEquities(env: Env) { return refreshEquitiesKv(env, [], false); }

async function sendTelegram(env: Env, text: string) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  return r.ok;
}

function footer() {
  return "\n\n本提醒仅供观察，不构成投资建议，不会自动下单。";
}

export async function runScheduled(env: Env, trigger: string, opts: { dry?: boolean } = {}): Promise<LastRun> {
  const started = Date.now();
  const dry = !!opts.dry;
  if (!dry) {
    const lock = await env.STATE.get("lock");
    if (lock && started - Number(lock) < 90_000) {
      const run: LastRun = { at: iso(), atRome: rome(), trigger, ok: true, sent: 0, scanned: 0, skipped: "lock" };
      return run;
    }
    await env.STATE.put("lock", String(started), { expirationTtl: 120 });
  }

  try {
    const state = await loadMonitorState(env);
    const [tickersAll, oiAll, news] = await Promise.all([
      jfetch<Ticker[]>(VISION + "/api/v3/ticker/24hr", 15000),
      jfetch<{ code?: string; data?: { instId: string; oiUsd: string }[] }>(OKX + "/api/v5/public/open-interest?instType=SWAP", 12000),
      Promise.all([collectNews({ compact: true }), readAllNewsCaches(env)]).then(([a,b]) => {
        const seen = new Set<string>();
        const out: NewsItem[] = [];
        for (const it of [...a, ...b]) {
          const k = ((it.url || '').split('?')[0] || it.title || '').slice(0, 180);
          if (!k || seen.has(k)) continue;
          seen.add(k); out.push(it);
        }
        return out;
      }).catch(() => [] as NewsItem[]),
    ]);

    const liquid: Ticker[] = [];
    if (Array.isArray(tickersAll)) {
      for (const row of tickersAll) {
        const s = row.symbol || "";
        if (!s.endsWith("USDT") || LEV.test(s)) continue;
        const q = Number(row.quoteVolume || 0);
        if (q >= MIN_QUOTE) liquid.push(row);
      }
    }
    liquid.sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume));
    const bySym = new Map(liquid.map((r) => [r.symbol, r]));
    for (const s of MAJORS) {
      const row = (tickersAll || []).find((x) => x.symbol === s);
      if (row) bySym.set(s, row);
    }

    const oiRows = (oiAll?.code === "0" ? oiAll.data : []) || [];
    const oiUsdt = oiRows
      .filter((x) => x.instId?.endsWith("-USDT-SWAP"))
      .map((x) => ({ instId: x.instId, oiUsd: +x.oiUsd, sym: x.instId.replace("-USDT-SWAP", "USDT") }))
      .filter((x) => Number.isFinite(x.oiUsd))
      .sort((a, b) => b.oiUsd - a.oiUsd);

    const scanSet = new Set<string>(MAJORS);
    for (const r of liquid.slice(0, SCAN_CAP)) scanSet.add(r.symbol);
    for (const r of oiUsdt.slice(0, SCAN_CAP)) scanSet.add(r.sym);
    const scan = Array.from(scanSet);
    const tickers: Record<string, Ticker> = {};
    for (const s of scan) {
      const r = bySym.get(s) || (tickersAll || []).find((x) => x.symbol === s);
      if (r) tickers[s] = r;
    }

    const fundTargets = [
      ...MAJORS,
      ...oiUsdt.filter((x) => !MAJORS.includes(x.sym)).slice(0, FUND_CAP - MAJORS.length).map((x) => x.sym),
    ];
    const funding: Record<string, { rate: number; source: string; oi_usd?: number }> = {};
    await Promise.all(fundTargets.map(async (sym) => {
      const data = await jfetch<{ code?: string; data?: { fundingRate: string; fundingTime?: string; nextFundingTime?: string }[] }>(
        `${OKX}/api/v5/public/funding-rate?instId=${instOf(sym)}`, 8000,
      );
      if (data?.code === "0" && data.data?.[0]) {
        const oi = oiUsdt.find((x) => x.sym === sym)?.oiUsd;
        funding[sym] = { rate: +data.data[0].fundingRate, source: "OKX", oi_usd: oi };
        void okxNext(data.data[0]);
      }
    }));
    for (const r of oiUsdt) {
      if (funding[r.sym] && funding[r.sym].oi_usd == null) funding[r.sym].oi_usd = r.oiUsd;
    }

    const liquid50 = liquid.filter((x) => Number(x.quoteVolume) >= MIN_QUOTE);
    const volTargets = liquid50.slice(0, VOL_CAP).map((x) => x.symbol);
    const spikes: { symbol: string; ratio: number; chg: number; close: number; rangeHigh: number; rangeLow: number; dir: "up" | "down"; quoteVol: number }[] = [];
    await Promise.all(volTargets.map(async (sym) => {
      const data = await jfetch<(string | number)[][]>(`${VISION}/api/v3/klines?symbol=${sym}&interval=5m&limit=26`, 8000);
      if (!Array.isArray(data) || data.length < 12) return;
      const closed = data.slice(0, -1);
      const vols = closed.map((k) => +k[5]).filter((n) => Number.isFinite(n));
      if (vols.length < 8) return;
      const last = vols[vols.length - 1];
      const prev = vols.slice(0, -1).sort((a, b) => a - b);
      const med = prev[Math.floor(prev.length / 2)];
      if (med <= 0 || last / med < VOL_RATIO) return;
      const prior = closed.slice(0, -1);
      const rangeHigh = Math.max(...prior.map((k) => +k[2]));
      const rangeLow = Math.min(...prior.map((k) => +k[3]));
      const candle = closed[closed.length - 1];
      const o = +candle[1], c = +candle[4];
      if (!rangeHigh || !rangeLow || !c) return;
      let dir: "up" | "down" | null = null;
      if (c > rangeHigh) dir = "up";
      else if (c < rangeLow) dir = "down";
      if (!dir) return;
      const chg = o ? (c / o - 1) * 100 : 0;
      const quoteVol = Number((tickers[sym] || liquid50.find((x) => x.symbol === sym) || {}).quoteVolume || 0);
      spikes.push({ symbol: sym, ratio: last / med, chg, close: c, rangeHigh, rangeLow, dir, quoteVol });
    }));

    const msgs: string[] = [];
    const dash = "https://dudihao1208-gif.github.io/trading-dashboard/";
    const cooledSym = (sym: string) => cooled(state, "opp:" + sym, COOL_MIN);
    const markSym = (sym: string) => mark(state, "opp:" + sym);

    // 机会只保留高流动性 + 共振，不再单凭资金费、放量或自选涨跌推送
    const prevOi = { ...(state.oi_usd || {}) };
    const nextOi = { ...prevOi };
    for (const [sym, row] of Object.entries(funding)) {
      if (row.oi_usd) nextOi[sym] = row.oi_usd;
    }
    state.oi_usd = nextOi;

    const fundOi: string[] = [];
    for (const [sym, row] of Object.entries(funding)) {
      const qv = Number((tickers[sym] || {}).quoteVolume || 0);
      if (qv < MIN_QUOTE) continue;
      if (Math.abs(row.rate) < FUND_TH) continue;
      const oi = row.oi_usd;
      if (!oi) continue;
      const oldOi = prevOi[sym];
      if (!oldOi) continue;
      const oiChg = (oi / oldOi - 1) * 100;
      if (Math.abs(oiChg) < OI_SURGE) continue;
      if (cooledSym(sym)) continue;
      const px = Number((tickers[sym] || {}).lastPrice || 0);
      const pxMove = Number((tickers[sym] || {}).priceChangePercent || 0);
      const crowdedLong = row.rate > 0;
      const dir = crowdedLong ? "偏空警戒" : "偏多警戒";
      const side = crowdedLong ? "多头付费，拥挤多头" : "空头付费，拥挤空头";
      fundOi.push(sym);
      msgs.push(
        `💸 资金费极端 + 持仓骤变 ${sym}（${dir}）
资金费率 ${(row.rate * 100).toFixed(4)}%（${side}），持仓 ${oiChg >= 0 ? "+" : ""}${oiChg.toFixed(1)}% 至约 $${Math.round(oi).toLocaleString()}，现价 ${px || "—"}，24h 价格 ${pxMove >= 0 ? "+" : ""}${pxMove.toFixed(2)}%。
${dash}?tab=chart&symbol=${sym}`
      );
      markSym(sym);
      if (msgs.length >= MAX_TOTAL) break;
    }
    for (const sp of spikes) {
      if (msgs.length >= MAX_TOTAL) break;
      if (fundOi.includes(sp.symbol) || cooledSym(sp.symbol)) continue;
      const dir = sp.dir === "up" ? "偏多" : "偏空";
      const level = sp.dir === "up" ? `站上近 2 小时区间高点 ${sp.rangeHigh}` : `跌破近 2 小时区间低点 ${sp.rangeLow}`;
      const qv = sp.quoteVol ? `，24h 成交约 $${Math.round(sp.quoteVol).toLocaleString()}` : "";
      msgs.push(
        `📊 放量突破 ${sp.symbol}（${dir}）\n5m 成交量为近端中位数的 ${sp.ratio.toFixed(1)} 倍，收 ${sp.close} ${level}（区间 ${sp.rangeLow}–${sp.rangeHigh}）${qv}。\n${dash}?tab=chart&symbol=${sp.symbol}`
      );
      markSym(sp.symbol);
    }

    const newsRoom = Math.max(0, Math.min(MAX_NEWS, MAX_TOTAL - msgs.length));
    if (newsRoom > 0) {
      const ev = await evaluateNews(env, news, 24);
      const picked = ev.newPassed.slice(0, newsRoom + 3); // 预留冷却后仍够用
      let translated: NewsItem[] = picked;
      try { translated = await translateNews(env, picked); } catch { /* 用原文 */ }
      const byUrl = new Map(translated.map((it) => [(it.url || "").split("?")[0], it]));
      for (const it of ev.newPassed) {
        if (msgs.filter((m) => m.startsWith("📰")).length >= newsRoom) break;
        const key = "news:" + (storyKey(it.titleZh || it.title) || (it.url || "").split("?")[0] || it.title).slice(0, 180);
        if (cooled(state, key, 24 * 60)) continue;
        const zh = byUrl.get((it.url || "").split("?")[0]) || it;
        msgs.push(formatNewsTelegram({ ...it, ...zh }));
        mark(state, key);
      }
    }

    const sendable = msgs.slice(0, MAX_TOTAL);
    let sent = 0;
    if (sendable.length && !opts.dry) {
      const body = "📡 观察台提醒\n" + rome() + "\n\n" + sendable.join("\n\n") + footer();
      const ok = await sendTelegram(env, body);
      if (ok) sent = sendable.length;
    }

    if (!dry) await saveMonitorState(env, state);
    const run: LastRun = {
      at: iso(),
      atRome: rome(),
      trigger,
      ok: true,
      sent: dry ? 0 : sent,
      scanned: scan.length,
      sources: ["vision-24hr", "okx-funding", "okx-oi", "news"],
      skipped: dry ? "dry-run" : (sendable.length && !sent ? "telegram-failed-or-missing" : undefined),
      preview: dry ? sendable : undefined,
    };
    if (!dry) await writeLastRun(env, run);
    return run;
  } catch (e) {
    const run: LastRun = {
      at: iso(), atRome: rome(), trigger, ok: false, sent: 0, scanned: 0,
      error: e instanceof Error ? e.message : String(e),
    };
    if (!dry) await writeLastRun(env, run);
    return run;
  }
}

export async function saveNewsCache(env: Env, source: string, items: NewsItem[], extra: Record<string, unknown> = {}) {
  await env.STATE.put("news-cache:" + source, JSON.stringify({ generated_at: new Date().toISOString(), source, items, ...extra }));
}
export async function readAllNewsCaches(env: Env): Promise<NewsItem[]> {
  const out: NewsItem[] = [];
  const list = await env.STATE.list({ prefix: "news-cache:" });
  for (const k of list.keys) {
    try {
      const raw = await env.STATE.get(k.name);
      const d = raw ? JSON.parse(raw) as { items?: NewsItem[] } : {};
      out.push(...(d.items || []));
    } catch { /* skip */ }
  }
  return out;
}
