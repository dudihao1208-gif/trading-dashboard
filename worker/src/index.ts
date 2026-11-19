/**
 * 只读代理：为观察台解开无 CORS 的公开接口。
 * 严格白名单，拒绝任意 URL，避免变成开放代理。
 */
const ALLOW_PREFIX = [
  "https://www.okx.com/api/v5/",
  "https://fapi.binance.com/",
  "https://api.binance.com/",
  "https://data-api.binance.vision/",
  "https://query1.finance.yahoo.com/",
  "https://query2.finance.yahoo.com/",
  "https://nfs.faireconomy.media/",
  "https://www.jinse.cn/",
  "https://api.jinse.cn/",
  "https://www.odaily.news/",
  "https://cms.odaily.news/",
  "https://www.theblockbeats.info/",
  "https://api.theblockbeats.info/",
  "https://www.wsj.com/", // unused; keep tight — actually don't allow wsj
];

// 去掉误加的 wsj
const ALLOW = ALLOW_PREFIX.filter((x) => !x.includes("wsj.com"));

const NEWS_FEEDS: { source: string; url: string }[] = [
  { source: "金色财经", url: "https://www.jinse.cn/rss" },
  { source: "Odaily", url: "https://www.odaily.news/rss/v1" },
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
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

function parseRss(xml: string, source: string) {
  const items: { title: string; url: string; source: string; t: number }[] = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const b of blocks.slice(0, 20)) {
    const title = (b.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]>| <title[^>]*>([^<]+)/i) || [])[1] || (b.match(/<title[^>]*>([^<]+)/i) || [])[1] || "";
    const link = (b.match(/<link[^>]*><!\[CDATA\[(.*?)\]\]>| <link[^>]*>([^<]+)/i) || [])[1] || (b.match(/<link[^>]*>([^<]+)/i) || [])[1] || "";
    const date = (b.match(/<pubDate[^>]*>([^<]+)/i) || [])[1];
    const t = date ? Date.parse(date) : Date.now();
    if (title && link) items.push({ title: title.trim(), url: link.trim(), source, t: Number.isFinite(t) ? t : Date.now() });
  }
  return items;
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/health" || url.pathname === "/") {
      return json({ ok: true, service: "trading-dashboard-proxy" });
    }

    if (url.pathname === "/news/zh") {
      const all: { title: string; url: string; source: string; t: number }[] = [];
      for (const f of NEWS_FEEDS) {
        try {
          const r = await fetch(f.url, { headers: { "User-Agent": "trading-dashboard-proxy/2.0" } });
          if (!r.ok) continue;
          all.push(...parseRss(await r.text(), f.source));
        } catch { /* skip feed */ }
      }
      all.sort((a, b) => b.t - a.t);
      return json({ items: all.slice(0, 30) });
    }

    if (url.pathname === "/proxy") {
      const target = url.searchParams.get("url") || "";
      if (!allowed(target)) return json({ error: "url not allowed" }, 400);
      const r = await fetch(target, { headers: { "User-Agent": "trading-dashboard-proxy/2.0", Accept: "application/json" } });
      const body = await r.arrayBuffer();
      const headers = new Headers(cors);
      headers.set("Content-Type", r.headers.get("Content-Type") || "application/json");
      headers.set("Cache-Control", "public, max-age=15");
      return new Response(body, { status: r.status, headers });
    }

    return json({ error: "not found" }, 404);
  },
};
