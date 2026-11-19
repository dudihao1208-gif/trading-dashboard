/**
 * 只读代理 + 定时监控。
 * CORS 仅放行观察台 GitHub Pages 源。
 * 去重状态存在 KV；cron 每 10 分钟跑机会雷达。
 */
import { collectNews, cleanUrl, parseSourceTime, isReliablePublishTime, formatRome } from "./news";
import { translateNews } from "./translate";
import { evaluateNews } from "./score";
import { getCalendar, getEquities, loadMonitorState, readLastRun, runScheduled, saveMonitorState, saveNewsCache, readAllNewsCaches, type LastRun } from "./monitor";

export interface Env {
  STATE: KVNamespace;
  AI?: { run: (model: string, inputs: Record<string, unknown>) => Promise<unknown> };
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  MONITOR_SECRET?: string;
}

const ALLOWED_ORIGINS = new Set(["https://dudihao1208-gif.github.io"]);

const ALLOW = [
  "https://www.okx.com/api/v5/",
  "https://fapi.binance.com/",
  "https://api.binance.com/",
  "https://data-api.binance.vision/",
  "https://query1.finance.yahoo.com/",
  "https://query2.finance.yahoo.com/",
  "https://nfs.faireconomy.media/",
];

const UA = "Mozilla/5.0 (compatible; trading-dashboard-proxy/2.1)";

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  if (ALLOWED_ORIGINS.has(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Monitor-Secret",
      Vary: "Origin",
    };
  }
  return { Vary: "Origin" };
}

function json(data: unknown, req: Request, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(req) },
  });
}

function originBlocked(req: Request): Response | null {
  const origin = req.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return json({ error: "origin not allowed" }, req, 403);
  }
  return null;
}

function allowed(url: string) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return ALLOW.some((p) => url.startsWith(p));
  } catch {
    return false;
  }
}

function authorized(req: Request, env: Env): boolean {
  const secret = env.MONITOR_SECRET || "";
  if (!secret) return false;
  const h = req.headers.get("Authorization") || "";
  const bearer = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  const alt = req.headers.get("X-Monitor-Secret") || "";
  return bearer === secret || alt === secret;
}

async function proxy(url: string): Promise<Response> {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json, text/plain, */*" },
  });
  const headers = new Headers();
  const ct = r.headers.get("Content-Type");
  if (ct) headers.set("Content-Type", ct);
  return new Response(r.body, { status: r.status, headers });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") {
      const last = await readLastRun(env);
      return json({ ok: true, lastRun: last }, req);
    }

    if (path === "/news/zh") {
      const blocked = originBlocked(req);
      if (blocked) return blocked;
      try {
        const [live, cached] = await Promise.all([collectNews(), readAllNewsCaches(env)]);
        const seen = new Set<string>();
        const items = [];
        for (const it of [...live, ...cached].sort((a, b) => (b.t || 0) - (a.t || 0))) {
          const k = ((it.url || "").split("?")[0] || it.title || "").slice(0, 180);
          if (!k || seen.has(k)) continue;
          seen.add(k);
          items.push(it);
        }
        const translated = await translateNews(env, items.slice(0, 50));
        const sources: Record<string, number> = {};
        for (const it of translated) sources[it.source] = (sources[it.source] || 0) + 1;
        return json({ items: translated.map(({ excerpt, ...rest }) => rest), sources, generated_at: new Date().toISOString() }, req);
      } catch {
        return json({ items: [], error: "news failed" }, req, 502);
      }
    }

    if (path === "/news/cache") {
      if (!authorized(req, env)) return json({ error: "unauthorized" }, req, 401);
      const body = await req.json() as { source?: string; items?: { title: string; url: string; source?: string; t?: number; important?: boolean }[] };
      if (!body.source || !Array.isArray(body.items)) return json({ error: "bad body" }, req, 400);
      const items = body.items.filter((x) => x.title && x.url).map((x) => {
        const pub = parseSourceTime(x.t);
        const pubOk = pub > 0 && (x as { pubOk?: boolean }).pubOk !== false && isReliablePublishTime(pub);
        return {
          title: x.title, url: cleanUrl(x.url), source: x.source || body.source!, t: pubOk ? pub : 0, pubOk, important: x.important !== false,
        };
      });
      await saveNewsCache(env, body.source, items);
      return json({ ok: true, n: items.length }, req);
    }

    if (path === "/calendar") {
      const blocked = originBlocked(req);
      if (blocked) return blocked;
      const data = await getCalendar(env);
      return json(data, req);
    }

    if (path === "/equities") {
      const blocked = originBlocked(req);
      if (blocked) return blocked;
      const data = await getEquities(env);
      return json(data, req);
    }

    if (path === "/monitor/status") {
      // 公开：只返回上次定时运行摘要，不含密钥
      const last = await readLastRun(env);
      return json({ ok: true, lastRun: last }, req);
    }

    if (path === "/monitor/state") {
      if (!authorized(req, env)) return json({ error: "unauthorized" }, req, 401);
      if (req.method === "GET") {
        const state = await loadMonitorState(env);
        const last = await readLastRun(env);
        return json({ ...state, lastRun: last }, req);
      }
      if (req.method === "PUT" || req.method === "POST") {
        const body = await req.json() as { alerts?: Record<string, number>; oi_usd?: Record<string, number> };
        const cur = await loadMonitorState(env);
        const alerts = { ...cur.alerts, ...(body.alerts || {}) };
        const oi = { ...cur.oi_usd, ...(body.oi_usd || {}) };
        await saveMonitorState(env, { alerts, oi_usd: oi });
        return json({ ok: true }, req);
      }
      return json({ error: "method" }, req, 405);
    }

    if (path === "/monitor/run") {
      if (!authorized(req, env)) return json({ error: "unauthorized" }, req, 401);
      const dry = url.searchParams.get("dry") === "1" || url.searchParams.get("dry") === "true";
      const run = await runScheduled(env, dry ? "manual-dry" : "manual", { dry });
      return json(run, req);
    }

    if (path === "/monitor/backfill" || path === "/monitor/filter-news") {
      if (!authorized(req, env)) return json({ error: "unauthorized" }, req, 401);
      const hours = Math.min(72, Math.max(0.1, Number(url.searchParams.get("hours") || 2) || 2));
      let incoming: { title: string; url: string; source?: string; t?: number; important?: boolean; titleZh?: string; summaryZh?: string; excerpt?: string }[] = [];
      if (req.method === "POST") {
        try {
          const body = await req.json() as { items?: typeof incoming; hours?: number };
          if (Array.isArray(body.items)) incoming = body.items;
        } catch { /* ignore */ }
      }
      const [live, cached] = await Promise.all([collectNews({ compact: true }), readAllNewsCaches(env)]);
      const seen = new Set<string>();
      const merged = [];
      for (const it of [...incoming, ...live, ...cached]) {
        if (!it?.title || !it?.url) continue;
        const k = ((it.url || "").split("?")[0] || it.title || "").slice(0, 180);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        merged.push(it);
      }
      const ev = await evaluateNews(env, merged, hours);
      let translatedPass = ev.newPassed;
      try { translatedPass = await translateNews(env, ev.newPassed) as typeof ev.newPassed; } catch { /* 原文 */ }
      const slim = (it: (typeof ev.newPassed)[number] | (typeof ev.oldPassed)[number]) => {
        const pub = parseSourceTime(it.t);
        const ageMin = pub ? Math.round((Date.now() - pub) / 60000) : null;
        return {
          title: it.title,
          titleZh: (it as { titleZh?: string }).titleZh || "",
          source: it.source,
          url: cleanUrl(it.url),
          t: pub,
          publishedAtRome: pub ? formatRome(pub) : "",
          ageMinutes: ageMin,
          olderThan2h: !pub || (ageMin != null && ageMin > 120),
          pubOk: isReliablePublishTime(pub),
          score: (it as { score?: number }).score,
          whyZh: (it as { whyZh?: string }).whyZh || "",
          via: (it as { via?: string }).via,
          category: (it as { category?: string }).category,
        };
      };
      return json({
        hours,
        collected: merged.filter((it) => isReliablePublishTime(it.t) && it.t >= Date.now() - hours * 3600_000).length,
        oldCount: ev.oldPassed.length,
        newCount: ev.newPassed.length,
        oldTitles: ev.oldPassed.map(slim),
        newTitles: translatedPass.map((it, i) => slim({ ...ev.newPassed[i], ...it })),
        olderThan2hInNew: translatedPass.map((it, i) => slim({ ...ev.newPassed[i], ...it })).filter((x) => x.olderThan2h).length,
        note: "对照为近 N 小时资讯（默认 2 小时）：只采用来源原始发布时间，无可靠发布时间的不推。新规则=评分≥4且 URL/故事去重。本接口不发 Telegram，不改 lastRun/冷却状态。",
      }, req);
    }

    if (path === "/proxy") {
      const blocked = originBlocked(req);
      if (blocked) return blocked;
      const target = url.searchParams.get("url") || "";
      if (!allowed(target)) return json({ error: "url not allowed" }, req, 400);
      try {
        const r = await proxy(target);
        const headers = new Headers(r.headers);
        const cors = corsHeaders(req);
        for (const [k, v] of Object.entries(cors)) headers.set(k, v);
        return new Response(r.body, { status: r.status, headers });
      } catch {
        return json({ error: "proxy failed" }, req, 502);
      }
    }

    return json({ error: "not found" }, req, 404);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, "cron"));
  },
};

export type { LastRun };
