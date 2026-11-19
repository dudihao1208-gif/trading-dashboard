const UA = "Mozilla/5.0 (compatible; trading-dashboard-proxy/2.1; +https://dudihao1208-gif.github.io/trading-dashboard/)";

export type NewsItem = { title: string; url: string; source: string; t: number; important?: boolean; excerpt?: string; titleZh?: string; summaryZh?: string };

const TRACK = /^(utm_.*|fbclid|gclid|gclsrc|dclid|msclkid|twclid|yclid|mc_cid|mc_eid|igshid|si|icid|cmpid|ncid|spm|scm|ref|ref_src|_ga|_gl|wbraid|gbraid|ocid|srsltid|mkt_tok)$/i;

export function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) {
      if (TRACK.test(k)) u.searchParams.delete(k);
    }
    u.hash = "";
    let s = u.toString();
    if (s.endsWith("?") || s.endsWith("&")) s = s.replace(/[?&]+$/, "");
    return s;
  } catch {
    return raw;
  }
}

/** 标题以拉丁字母为主则视为英文，需翻译；已是中文的不译。 */
export function isMostlyEnglish(s: string): boolean {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  if (cjk >= 4 && cjk >= latin) return false;
  return latin >= 6 && latin > cjk;
}


const IMPORTANCE = [
  "ETF", "SEC", "CFTC", "FOMC", "CPI", "PCE", "NFP", "Fed", "FED",
  "美联储", "加息", "降息", "利率", "非农", "通胀", "监管", "制裁", "起诉", "立案",
  "上币", "下架", "上线", "下线", "暂停充", "暂停提", "充提", "上市", "新币", "新上",
  "黑客", "被盗", "盗币", "攻击", "漏洞", "hack", "exploit", "breach",
  "listing", "delisting", "lawsuit", "approval", "approved", "Will List", "Will Delist",
  "破产", "暴雷", "停牌", "冻结", "调查", "罚单", "罚款",
  "现货ETF", "比特币ETF", "以太坊ETF", "opens trading", "New Listing",
];

export function isImportantHeadline(title: string, source = ""): boolean {
  const t = (title || "").trim();
  if (t.length < 6) return false;
  if (source.includes("币安") && /上币|下架|上线|下线|上市|listing|delist|Will List|New Listing|opens trading|新币/i.test(t)) return true;
  return IMPORTANCE.some((k) => t.toLowerCase().includes(k.toLowerCase()));
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

function parseRss(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const b of blocks.slice(0, 20)) {
    const titleRaw = (b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const linkRaw = (b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || (b.match(/<link[^>]+href="([^"]+)"/i) || [])[1] || "";
    const date = (b.match(/<pubDate[^>]*>([^<]+)/i) || [])[1];
    const descRaw = (b.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] || (b.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i) || [])[1] || "";
    const title = decodeXml(titleRaw);
    const link = cleanUrl(decodeXml(linkRaw));
    const excerpt = decodeXml(descRaw).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
    const t = date ? Date.parse(date) : Date.now();
    if (title && link) items.push({ title, url: link, source, t: Number.isFinite(t) ? t : Date.now(), important: isImportantHeadline(title, source), excerpt: excerpt || undefined });
  }
  return items;
}

async function fetchText(url: string, headers: Record<string, string> = {}, timeoutMs = 4000): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function soft<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try { return await fn(); } catch { return []; }
}

export async function collectNews(opts: { compact?: boolean } = {}): Promise<NewsItem[]> {
  const tasks: Promise<NewsItem[]>[] = [
    soft(async () => {
      const raw = await fetchText("https://api-one-wscn.awtmt.com/apiv1/content/information-flow?channel=global-channel&limit=16", { Accept: "application/json" });
      const d = JSON.parse(raw) as { data?: { items?: { resource?: Record<string, unknown> }[] } };
      const out: NewsItem[] = [];
      for (const it of d.data?.items || []) {
        const r = it.resource || {};
        const title = String(r.title || r.content_short || "").trim();
        const url = String(r.uri || r.source_uri || "").trim();
        const t = Number(r.display_time || 0);
        if (title && url) out.push({ title, url: cleanUrl(url), source: "华尔街见闻", t: t > 1e12 ? t : t * 1000 || Date.now(), important: isImportantHeadline(title, "华尔街见闻") });
      }
      return out.slice(0, 8);
    }),
    soft(async () => {
      const hosts = ["https://www.binance.info", "https://www.binance.com"];
      const paths = [
        "/bapi/composite/v1/public/cms/article/catalog/list/query?catalogId=48&pageNo=1&pageSize=8",
        "/bapi/composite/v1/public/cms/article/catalog/list/query?catalogId=49&pageNo=1&pageSize=8",
        "/bapi/composite/v1/public/cms/article/catalog/list/query?catalogId=161&pageNo=1&pageSize=8",
        "/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=10",
      ];
      const out: NewsItem[] = [];
      for (const host of hosts) {
        if (out.length) break;
        await Promise.all(paths.map(async (path) => {
          try {
            const raw = await fetchText(host + path, { Accept: "application/json", lang: "zh-CN" }, 3500);
            const d = JSON.parse(raw) as { data?: { articles?: { title?: string; code?: string; releaseDate?: number }[]; catalogs?: { articles?: { title?: string; code?: string; releaseDate?: number }[] }[] } };
            const arts = d.data?.articles || (d.data?.catalogs || []).flatMap((c) => c.articles || []);
            for (const a of arts) {
              const title = String(a.title || "").trim();
              const code = String(a.code || "").trim();
              if (!title) continue;
              const link = code ? `https://www.binance.com/zh-CN/support/announcement/${code}` : "https://www.binance.com/zh-CN/support/announcement";
              out.push({ title, url: cleanUrl(link), source: "币安公告", t: Number(a.releaseDate) || Date.now(), important: true });
            }
          } catch { /* skip this host/path */ }
        }));
      }
      const seen = new Set<string>();
      const uniq: NewsItem[] = [];
      for (const it of out) {
        if (seen.has(it.title)) continue;
        seen.add(it.title);
        uniq.push(it);
      }
      return uniq.slice(0, 12);
    }),
    soft(async () => parseRss(await fetchText("https://www.coindesk.com/arc/outboundfeeds/rss/"), "CoinDesk").slice(0, 8)),
    soft(async () => parseRss(await fetchText("https://cointelegraph.com/rss"), "Cointelegraph").slice(0, 8)),
    soft(async () => parseRss(await fetchText("https://www.theblock.co/rss.xml"), "The Block").slice(0, 8)),
    soft(async () => parseRss(await fetchText("https://decrypt.co/feed"), "Decrypt").slice(0, 6)),
  ];
  if (!opts.compact) {
    tasks.push(
      soft(async () => parseRss(await fetchText("https://www.jinse.cn/rss"), "金色财经").slice(0, 8)),
      soft(async () => parseRss(await fetchText("https://www.odaily.news/rss/v1"), "Odaily").slice(0, 8)),
      soft(async () => parseRss(await fetchText("https://www.theblockbeats.info/news/feed"), "BlockBeats").slice(0, 8)),
      soft(async () => parseRss(await fetchText("https://rss.panewslab.com/zh/news/rss"), "PANews").slice(0, 8)),
    );
  }
  // 精简模式跳过现场拉取币安 CMS（Cloudflare IP 常被拦；由 monitor.py 写入 KV 缓存）
  if (opts.compact) tasks.splice(1, 1);
  const buckets: NewsItem[][] = await Promise.all(tasks);

  const all = buckets.flat();
  const seen = new Set<string>();
  const uniq: NewsItem[] = [];
  for (const it of all.sort((a, b) => b.t - a.t)) {
    const k = (it.url.split("?")[0] || it.title).slice(0, 180);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(it);
  }
  return uniq.slice(0, 50);
}
