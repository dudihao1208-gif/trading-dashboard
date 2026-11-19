/**
 * 只读代理：为观察台解开无 CORS 的公开接口。
 * 严格白名单，拒绝任意 URL，避免变成开放代理。
 * CORS 仅放行观察台 GitHub Pages 源。
 */
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

const NEWS_FEEDS: { source: string; url: string }[] = [
  { source: "金色财经", url: "https://www.jinse.cn/rss" },
  { source: "Odaily", url: "https://www.odaily.news/rss/v1" },
];

const UA = "trading-dashboard-proxy/2.0";

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  if (ALLOWED_ORIGINS.has(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
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

function decodeXml(s: string) {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseRss(xml: string, source: string) {
  const items: { title: string; url: string; source: string; t: number }[] = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const b of blocks.slice(0, 20)) {
    const titleRaw = (b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const linkRaw = (b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || (b.match(/<link[^>]+href="([^"]+)"/i) || [])[1] || "";
    const date = (b.match(/<pubDate[^>]*>([^<]+)/i) || [])[1];
    const title = decodeXml(titleRaw);
    const link = decodeXml(linkRaw);
    const t = date ? Date.parse(date) : Date.now();
    if (title && link) items.push({ title, url: link, source, t: Number.isFinite(t) ? t : Date.now() });
  }
  return items;
}

async function fetchText(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}

async function collectNews(): Promise<{ title: string; url: string; source: string; t: number }[]> {
  const all: { title: string; url: string; source: string; t: number }[] = [];

  try {
    const raw = await fetchText(
      "https://api-one-wscn.awtmt.com/apiv1/content/information-flow?channel=global-channel&limit=20",
      { Accept: "application/json" },
    );
    const d = JSON.parse(raw) as { data?: { items?: { resource?: Record<string, unknown> }[] } };
    for (const it of d.data?.items || []) {
      const r = it.resource || {};
      const title = String(r.title || r.content_short || "").trim();
      const url = String(r.uri || r.source_uri || "").trim();
      const t = Number(r.display_time || 0);
      if (title && url) all.push({ title, url, source: "华尔街见闻", t: t > 1e12 ? t : t * 1000 || Date.now() });
    }
  } catch { /* skip */ }

  try {
    const raw = await fetchText(
      "https://www.binance.com/bapi/composite/v1/public/cms/article/catalog/list/query?catalogId=48&pageNo=1&pageSize=12",
      { Accept: "application/json", lang: "zh-CN" },
    );
    const d = JSON.parse(raw) as { data?: { articles?: { title?: string; code?: string; releaseDate?: number }[] } };
    for (const a of d.data?.articles || []) {
      const title = String(a.title || "").trim();
      const code = String(a.code || "").trim();
      if (!title || !code) continue;
      all.push({
        title,
        url: "https://www.binance.com/zh-CN/support/announcement/" + code,
        source: "币安公告",
        t: Number(a.releaseDate) || Date.now(),
      });
    }
  } catch { /* skip */ }

  for (const f of NEWS_FEEDS) {
    try {
      all.push(...parseRss(await fetchText(f.url), f.source));
    } catch { /* skip feed */ }
  }

  const seen = new Set<string>();
  const uniq = all.filter((x) => {
    const k = x.title.replace(/\s+/g, "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  uniq.sort((a, b) => b.t - a.t);
  const bySrc: Record<string, typeof uniq> = {};
  for (const it of uniq) (bySrc[it.source] ||= []).push(it);
  const mixed: typeof uniq = [];
  const caps: Record<string, number> = { "华尔街见闻": 16, "币安公告": 10, "金色财经": 8, Odaily: 8 };
  const used = new Set<string>();
  for (const [src, cap] of Object.entries(caps)) {
    for (const it of (bySrc[src] || []).slice(0, cap)) {
      mixed.push(it);
      used.add(it.title);
    }
  }
  for (const it of uniq) if (!used.has(it.title)) mixed.push(it);
  mixed.sort((a, b) => b.t - a.t);
  return mixed.slice(0, 30);
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      const blocked = originBlocked(req);
      if (blocked) return blocked;
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
    if (req.method !== "GET") return json({ error: "method not allowed" }, req, 405);

    const blocked = originBlocked(req);
    if (blocked) return blocked;

    if (url.pathname === "/health" || url.pathname === "/") {
      return json({ ok: true, service: "trading-dashboard-proxy" }, req);
    }

    if (url.pathname === "/news/zh") {
      return json({ items: await collectNews() }, req);
    }

    if (url.pathname === "/proxy") {
      const target = url.searchParams.get("url") || "";
      if (!allowed(target)) return json({ error: "url not allowed" }, req, 400);
      const r = await fetch(target, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; " + UA + ")", Accept: "application/json, text/plain, */*" },
      });
      const body = await r.arrayBuffer();
      const headers = new Headers(corsHeaders(req));
      headers.set("Content-Type", r.headers.get("Content-Type") || "application/json");
      headers.set("Cache-Control", "public, max-age=15");
      return new Response(body, { status: r.status, headers });
    }

    return json({ error: "not found" }, req, 404);
  },
};
