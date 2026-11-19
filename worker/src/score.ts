import type { Env } from "./index";
import type { NewsItem } from "./news";
import { cleanUrl } from "./news";

const LLM = "@cf/meta/llama-3.2-3b-instruct";
const TTL = 7 * 24 * 3600;
const BATCH = 4;

export type ScoredNews = NewsItem & {
  score: number;
  whyZh: string;
  category: string;
  via: "hard" | "llm" | "heuristic";
};

const OPINION = /here'?s why|why it (?:matters|may)|opinion|analysis|recap|commentary|editorial|interview|op-ed|column|long & short|long and short|what happened in crypto today|here'?s what happened|price prediction|could beat|may be a mistake|analysts? say|should we (really )?(blame|care|worry)|is it time to|what it means for|专家认为|点评|评论员|为何值得|今日要闻|每日回顾/i;
const WARN_ONLY = /senators? warn|\bsenators?:|legislators? (?:warn|urge)|could push|may (?:run|be|push)|warn(?:s|ed)? (?:that|it)|警告(?:可能|或)|呼吁|建议国会/i;
const LISTING = /will list|will delist|new listing|opens trading|will launch .{0,40}(perpetual|futures|合约)|上币|下架|下线|新上.?币|将上架|将推出.{0,20}(永续|合约|期货)/i;
const ETF_ACTION = /etf.{0,40}(approv|reject|deny|inflow|outflow|flow)|现货etf.{0,20}(获批|批准|否决|流入|流出)|(approv|reject|deny).{0,30}etf|(inflow|outflow).{0,20}(\$|usd|billion|million|亿)|净(流入|流出).{0,10}(亿|美元|\$)/i;
const REG_ACTION = /\b(sec|cftc)\b.{0,40}(charg|sue|enforcement|settlement|fine|lawsuit|indict|order)|filed (a )?(lawsuit|charges)|law (?:passed|signed|enacted)|court (?:order|rules|grants)|冻结令|起诉|立案|罚单|执法|通过.{0,6}(法案|法律)/i;
const MACRO_PRINT = /\b(cpi|pce|nfp|nonfarm|fomc|fed)\b.{0,30}(print|comes? in|released?|holds?|cuts?|hikes?|raises?|keeps?)|(cpi|非农|pce|利率).{0,10}(公布|落地|决议|维持|上调|下调|降息|加息)|降息.{0,6}(基点|bp)|加息.{0,6}(基点|bp)/i;
const OUTAGE = /outage|halted withdrawals?|suspends? (withdrawals?|trading)|insolven|bankrupt|bank run|暂停(充|提|交易)|宕机|提现暂停|破产|暴雷|停摆/i;
const UNLOCK = /token unlock|cliff unlock|解锁.{0,10}(代币|token)|大额解锁/i;
const HACK = /hack|exploit|breach|stolen|drained|被盗|盗币|攻击|漏洞利用|被黑/i;
const HACK_FOLLOW = /court docs|court documents|freezing order|冻结令|recover stolen|investigation|investigat|after the (?:hack|exploit)|expands .{0,20}hack/i;
const NOT_LISTING = /collateral asset|as collateral|抵押品|作为抵押|zero maker fee promotion/i;
const MAJOR_VENUE = /binance|coinbase|okx|bybit|kraken|bitfinex|bitget|upbit|gemini|tether|uniswap|aave|lido|makerdao|maker\b|币安|火币|欧易/i;
const TOP_COIN_UNLOCK = /unlock.{0,20}(btc|eth|sol|bnb|xrp|doge|ada|avax|dot|link|sui|near|apt)| (btc|eth|sol|bnb|xrp|doge|ada|avax|sui).{0,20}unlock/i;

export function parseUsd(text: string): number | null {
  const t = (text || "").replace(/,/g, " ");
  const patterns: [RegExp, (n: number) => number][] = [
    [/\$?\s*(\d+(?:\.\d+)?)\s*(?:billion|bn)\b/i, (n) => n * 1e9],
    [/\$\s*(\d+(?:\.\d+)?)\s*b\b/i, (n) => n * 1e9],
    [/(\d+(?:\.\d+)?)\s*亿美元/i, (n) => n * 1e8],
    [/\$?\s*(\d+(?:\.\d+)?)\s*(?:million|mm|mio)\b/i, (n) => n * 1e6],
    [/\$\s*(\d+(?:\.\d+)?)\s*m\b/i, (n) => n * 1e6],
    [/(\d+(?:\.\d+)?)\s*万美元/i, (n) => n * 1e4],
    [/(\d+(?:\.\d+)?)\s*亿(?!美元)/i, (n) => n * 1e8],
  ];
  for (const [re, scale] of patterns) {
    const m = t.match(re);
    if (m) return scale(Number(m[1]));
  }
  return null;
}


export function extractPublishedAt(title: string, t?: number, source = ""): number {
  const m = (title || "").match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/) || (title || "").match(/(20\d{2})年(\d{1,2})月(\d{1,2})/);
  let fromTitle = 0;
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      fromTitle = Date.UTC(y, mo - 1, d, 12, 0, 0);
    }
  }
  const raw = t && t < 1e12 ? t * 1000 : (t || 0);
  // 币安缓存常常把抓取时刻写成 t；无标题日期则不采信
  if ((source || "").includes("币安") && !fromTitle) return 0;
  if (fromTitle && (!raw || raw - fromTitle > 36 * 3600_000)) return fromTitle;
  if (fromTitle) return fromTitle;
  return raw || 0;
}

export function isLowValueNews(title: string, source = "", excerpt = ""): boolean {
  const t = `${title} ${excerpt}`;
  if (OPINION.test(t) || OPINION.test(title)) return true;
  if (WARN_ONLY.test(t)) return true;
  if (/newsletter|daily digest|in today'?s (letter|newsletter)/i.test(title) && !HACK.test(t) && !LISTING.test(t)) return true;
  if (source.includes("华尔街见闻") && !MACRO_PRINT.test(t) && !ETF_ACTION.test(t) && !REG_ACTION.test(t) && !HACK.test(t)) {
    // 宏观媒体大量非加密点评，没有明确落地事件则视为低价值
    if (!/(bitcoin|btc|eth|crypto|比特币|以太|美联储|非农|cpi|etf)/i.test(t)) return true;
  }
  return false;
}

export function classifyBoost(title: string, source = "", excerpt = ""): string | null {
  const t = `${title} ${excerpt}`;
  if (NOT_LISTING.test(title)) {
    /* 抵押品、手续费活动不算上币 */
  } else if ((source.includes("币安") && LISTING.test(title)) || LISTING.test(title) || LISTING.test(t)) {
    return "listing";
  }
  if (HACK.test(t) && !HACK_FOLLOW.test(t)) {
    const usd = parseUsd(t);
    if ((usd != null && usd >= 10_000_000) || MAJOR_VENUE.test(title) || MAJOR_VENUE.test(t)) return "hack";
    return null;
  }
  if (ETF_ACTION.test(title)) return "etf";
  if (REG_ACTION.test(t) && !WARN_ONLY.test(t)) return "reg";
  if (MACRO_PRINT.test(t) && !/may be|here'?s why|可能是错误/i.test(t)) return "macro";
  if (OUTAGE.test(t) && MAJOR_VENUE.test(t)) return "outage";
  if (UNLOCK.test(t) && (TOP_COIN_UNLOCK.test(t) || MAJOR_VENUE.test(t))) return "unlock";
  return null;
}

/** 旧规则：关键词命中即推（用于回测对照）。 */
export function wouldOldFilterPass(it: NewsItem): boolean {
  if (!it.title) return false;
  if (it.important) return true;
  const t = it.title;
  if (t.length < 6) return false;
  if ((it.source || "").includes("币安") && LISTING.test(t)) return true;
  // 与原先 isImportantHeadline 词表大致等价的宽松匹配
  return /ETF|SEC|CFTC|FOMC|CPI|PCE|NFP|\bFed\b|美联储|加息|降息|利率|非农|通胀|监管|制裁|起诉|立案|上币|下架|上线|下线|暂停充|暂停提|充提|上市|新币|黑客|被盗|盗币|攻击|漏洞|hack|exploit|breach|listing|delisting|lawsuit|approval|approved|Will List|Will Delist|破产|暴雷|停牌|冻结|调查|罚单|罚款|opens trading|New Listing/i.test(t);
}

export function storyKey(title: string): string {
  const t = (title || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff$]+/g, " ")
    .replace(/\b(the|a|an|and|or|of|in|on|for|to|as|with|from|by|at|its|is|are|was|will|says?|after|over)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = t.split(" ").filter((w) => w.length >= 3 || /[0-9\u4e00-\u9fff]/.test(w)).slice(0, 8);
  return parts.join(" ");
}

function keyHash(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return "sc3:" + h.toString(16);
}

function llmText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const r = o.response ?? o.result ?? o.text;
    if (typeof r === "string") return r;
  }
  return "";
}

function defaultWhy(cat: string, title: string): string {
  const map: Record<string, string> = {
    listing: "交易所正式上架或下架/上线永续，相关合约流动性与价格可能立刻重定价。",
    hack: "大规模被盗或攻击会引发避险抛售，并冲击涉事交易所或协议的代币。",
    etf: "现货 ETF 审批或大额资金进出，会直接改变比特币等的买盘或卖压。",
    reg: "监管执法或法律落地可能改变合规预期，影响交易所与代币估值。",
    macro: "利率或重磅宏观数据公布，通常会带动风险资产整体波动。",
    outage: "大型交易所故障或兑付问题会打断交易并可能引发挤兑式抛售。",
    unlock: "主流币大额解锁增加流通供应，短线常有抛压。",
  };
  return map[cat] || `若属实，可能影响相关资产价格：${title.slice(0, 24)}`;
}

async function llmScore(env: Env, it: NewsItem): Promise<{ score: number; whyZh: string } | null> {
  if (!env.AI) return null;
  const title = it.titleZh || it.title;
  const extra = [it.summaryZh, it.excerpt].filter(Boolean).join(" ").slice(0, 280);
  try {
    const raw = await env.AI.run(LLM, {
      messages: [
        {
          role: "system",
          content: "你是严格的交易台编辑。只给会立刻影响价格、可交易的既成事实打高分。只输出 JSON：{\"score\":1到5的整数,\"why_zh\":\"一句中文，说明为何影响价格\"}。评分：5=能立刻驱动 BTC/ETH 或高流动性永续（上币下架、≥1000万美元或大所被黑、现货ETF批准/否决或数十亿美元级资金流、SEC/CFTC立案处罚或法律通过、美联储/CPI/非农落地、大所停摆或破产、主流币大额解锁）。4=更局部但仍可交易的既成事实。3=相关但还不能下单（警告、提案、无指控的调查、小额攻击、常规产品新闻）。2=评论/分析/预测/综述/议员警告。1=噪音。意见、预测、综述、Senator warning 一律≤2。金额明显不到1000万美元且非大所/大协议的攻击≤3。",
        },
        { role: "user", content: extra ? `标题：${title}\n补充：${extra}` : `标题：${title}` },
      ],
      max_tokens: 160,
      temperature: 0,
    });
    const text = llmText(raw);
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    const j = JSON.parse(text.slice(a, b + 1)) as { score?: number; why_zh?: string };
    const score = Math.max(1, Math.min(5, Math.round(Number(j.score))));
    if (!Number.isFinite(score)) return null;
    const whyZh = String(j.why_zh || "").trim();
    return { score, whyZh: whyZh.slice(0, 80) };
  } catch {
    return null;
  }
}

export async function scoreOne(env: Env, it: NewsItem): Promise<ScoredNews> {
  const title = it.title || "";
  const excerpt = `${it.excerpt || ""} ${it.summaryZh || ""}`;
  if (isLowValueNews(title, it.source, excerpt)) {
    return { ...it, score: 1, whyZh: "", category: "low", via: "hard" };
  }
  const cat = classifyBoost(title, it.source, excerpt);
  const maybeMarket = /etf|sec|cftc|\bfed\b|fomc|cpi|pce|nfp|hack|exploit|breach|stolen|listing|delist|unlock|批准|否决|执法|起诉|上架|下架|被盗|解锁|利率|非农|通胀|破产|停摆|宕机|流入|流出/i.test(`${title} ${excerpt}`);
  if (!cat && !maybeMarket) {
    return { ...it, score: 2, whyZh: "", category: "low", via: "heuristic" };
  }
  const cacheKey = keyHash((it.titleZh || title) + "|" + (it.source || ""));
  try {
    const cached = await env.STATE.get(cacheKey);
    if (cached) {
      const d = JSON.parse(cached) as { score: number; whyZh: string; category: string; via: ScoredNews["via"] };
      if (d && d.score >= 1 && d.score <= 5) return { ...it, ...d };
    }
  } catch { /* miss */ }

  let score = cat ? 4 : 3;
  let whyZh = cat ? defaultWhy(cat, it.titleZh || title) : "";
  let via: ScoredNews["via"] = cat ? "hard" : "heuristic";
  if (!cat) {
    const llm = await llmScore(env, it);
    if (llm) {
      via = "llm";
      score = llm.score;
      if (llm.whyZh) whyZh = llm.whyZh;
    }
  }
  if (!whyZh && score >= 4) whyZh = defaultWhy(cat || "", it.titleZh || title);
  const out: ScoredNews = { ...it, score, whyZh, category: cat || (score >= 4 ? "other" : "low"), via };
  try { await env.STATE.put(cacheKey, JSON.stringify({ score, whyZh, category: out.category, via }), { expirationTtl: TTL }); } catch { /* */ }
  return out;
}

function dedupeStories(items: ScoredNews[]): ScoredNews[] {
  const groups = new Map<string, ScoredNews[]>();
  const order: string[] = [];
  for (const it of items) {
    const k = storyKey(it.titleZh || it.title) || cleanUrl(it.url).split("?")[0];
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k)!.push(it);
  }
  const prefer = (s: string) => (s.includes("币安") ? 3 : /CoinDesk|The Block|Cointelegraph/i.test(s) ? 2 : 1);
  return order.map((k) => {
    const g = groups.get(k)!;
    g.sort((a, b) => prefer(b.source) - prefer(a.source) || b.score - a.score || (b.t || 0) - (a.t || 0));
    return g[0];
  });
}

export async function evaluateNews(
  env: Env,
  items: NewsItem[],
  hours = 24,
): Promise<{ oldPassed: NewsItem[]; newPassed: ScoredNews[]; scored: ScoredNews[] }> {
  const cutoff = Date.now() - hours * 3600_000;
  const windowed = items.filter((it) => {
    if (!it.title || !it.url) return false;
    const at = extractPublishedAt(it.title, it.t, it.source);
    return at >= cutoff;
  });
  const oldSeen = new Set<string>();
  const oldPassed: NewsItem[] = [];
  for (const it of windowed) {
    if (!wouldOldFilterPass(it)) continue;
    const k = (it.url || "").split("?")[0] || it.title;
    if (oldSeen.has(k)) continue;
    oldSeen.add(k);
    oldPassed.push(it);
  }

  const candidates = windowed.filter((it) => !isLowValueNews(it.title, it.source, `${it.excerpt || ""} ${it.summaryZh || ""}`));
  const boosts: NewsItem[] = [];
  const rest: NewsItem[] = [];
  for (const it of candidates) {
    if (classifyBoost(it.title, it.source, `${it.excerpt || ""} ${it.summaryZh || ""}`)) boosts.push(it);
    else rest.push(it);
  }
  rest.sort((a, b) => (b.t || 0) - (a.t || 0));
  const scored: ScoredNews[] = [];
  const queue = [...boosts, ...rest.slice(0, 8)]; // 硬类别全评（无 LLM），其余最多 8 条走模型
  for (let i = 0; i < queue.length; i += BATCH) {
    const chunk = queue.slice(i, i + BATCH);
    const rows = await Promise.all(chunk.map((it) => scoreOne(env, it)));
    scored.push(...rows);
  }
  const passed = dedupeStories(scored.filter((s) => s.score >= 4 && s.whyZh)).sort((a, b) => b.score - a.score || (b.t || 0) - (a.t || 0));
  return { oldPassed, newPassed: passed, scored };
}
