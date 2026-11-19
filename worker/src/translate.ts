import type { Env } from "./index";
import type { NewsItem } from "./news";
import { cleanUrl, isMostlyEnglish } from "./news";

const LLM = "@cf/meta/llama-3.2-3b-instruct";
const M2M = "@cf/meta/m2m100-1.2b";
const TTL = 7 * 24 * 3600;
const BATCH = 4;
const MAX_NEW = 16;

export function formatNewsTelegram(it: NewsItem & { whyZh?: string }): string {
  const title = (it.titleZh || it.title || "").trim();
  const why = (it.whyZh || "").trim();
  const url = cleanUrl(it.url || "");
  const lines = [`📰 ${title}`];
  if (why) lines.push(`为何影响价格：${why}`);
  lines.push(`来源：${it.source || "资讯"}`);
  if (url) lines.push(url);
  return lines.join("\n");
}

function keyOf(title: string, url: string) {
  const raw = (url.split("?")[0] || title).slice(0, 240);
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  return "tr4:" + h.toString(16) + ":" + raw.length;
}

function hasCjk(s: string) {
  return /[\u4e00-\u9fff]/.test(s || "");
}

function validZh(s: string) {
  const t = (s || "").trim();
  if (t.length < 2 || !hasCjk(t)) return false;
  if (/[{}]/.test(t) || /"(title|summary)"/i.test(t)) return false;
  return true;
}

function prepEn(s: string) {
  return (s || "")
    .replace(/USDⓈ-?Margined/gi, "USD-margined")
    .replace(/USDⓈ/g, "USD")
    .replace(/\bperpetual contracts?\b/gi, "perpetual contracts")
    .replace(/^\s*Previous\s*:?\s*/i, "")
    .trim();
}

function polishZh(s: string) {
  return (s || "")
    .replace(/永久性合同/g, "永续合约")
    .replace(/永久性合约/g, "永续合约")
    .replace(/USDS?\s*边缘(化的)?/g, "U本位")
    .replace(/市场前交易/g, "盘前交易")
    .replace(/担保资产/g, "抵押品")
    .replace(/零制造商费/g, "挂单零手续费")
    .replace(/种子标签应用/g, "种子标签")
    .replace(/将列出/g, "将上架")
    .replace(/^\s*上一篇\s*:?\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}


async function aiRun(env: Env, model: string, input: Record<string, unknown>, timeoutMs = 12000): Promise<unknown> {
  if (!env.AI) throw new Error("no AI binding");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await env.AI.run(model, input);
  } finally {
    clearTimeout(t);
  }
}

function parseLlm(raw: unknown): { title?: string; summary?: string } | null {
  let text = "";
  if (typeof raw === "string") text = raw;
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const r = o.response ?? o.result ?? o.text ?? o.translated_text;
    if (typeof r === "string") text = r;
    else if (r && typeof r === "object" && typeof (r as { response?: string }).response === "string") text = (r as { response: string }).response;
  }
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(text.slice(start, end + 1)) as { title?: string; summary?: string };
      return { title: String(j.title || "").trim(), summary: String(j.summary || "").trim() };
    } catch { /* fall through */ }
  }
  // 非 JSON 时，第一行当标题，第二行当摘要
  const lines = text.split(/\n+/).map((s) => s.replace(/^[#*\-\s]+/, "").trim()).filter(Boolean);
  if (lines[0]) return { title: lines[0].slice(0, 80), summary: (lines[1] || "").slice(0, 120) };
  return null;
}

function m2mText(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const t = o.translated_text ?? o.translatedText ?? o.text ?? o.result ?? o.response;
    if (typeof t === "string") return t.trim();
  }
  return "";
}

async function translateOne(env: Env, title: string, excerpt = ""): Promise<{ titleZh: string; summaryZh: string } | null> {
  // 标题用专用翻译模型，避免小 LLM 把数字量级译错或编造摘要。
  const viaM2m = async (text: string) => {
    for (const pair of [
      { source_lang: "en", target_lang: "zh" },
      { source_lang: "english", target_lang: "chinese" },
    ]) {
      try {
        const raw = await aiRun(env, M2M, { text, ...pair });
        const out = m2mText(raw);
        if (validZh(out)) return out;
      } catch { /* try next lang tag */ }
    }
    return "";
  };

  const titleZh = polishZh(await viaM2m(prepEn(title)));
  if (!titleZh) {
    // 翻译模型失败时，再用小模型试一次（须过中文校验）
    try {
      const raw = await aiRun(env, LLM, {
        messages: [
          { role: "system", content: "把英文新闻标题译成简体中文。只输出译文本身，不要解释。术语：perpetual contract=永续合约；USD-Margined=U本位；list=上架；delist=下架；futures=期货。" },
          { role: "user", content: title },
        ],
        max_tokens: 120,
        temperature: 0,
      });
      const parsed = parseLlm(raw);
      const cand = polishZh((parsed?.title || m2mText(raw) || "").trim());
      if (validZh(cand)) {
        const summaryZh = excerpt ? polishZh(await viaM2m(prepEn(excerpt.slice(0, 180)))) || cand : cand;
        return { titleZh: cand, summaryZh: summaryZh.slice(0, 80) };
      }
    } catch { /* give up */ }
    return null;
  }

  let summaryZh = titleZh;
  if (excerpt) {
    const s = polishZh(await viaM2m(prepEn(excerpt.slice(0, 220))));
    if (validZh(s)) summaryZh = s.replace(/\s+/g, " ").slice(0, 80);
  }
  return { titleZh, summaryZh };
}

export async function translateNews(env: Env, items: NewsItem[]): Promise<NewsItem[]> {
  const out = items.map((it) => ({ ...it, url: cleanUrl(it.url || "") }));
  const needIdx: number[] = [];
  for (let i = 0; i < out.length; i++) {
    const it = out[i];
    if (!it.title) continue;
    if (!isMostlyEnglish(it.title)) continue;
    if (validZh(it.titleZh || "") && (it.summaryZh || it.titleZh)) continue;
    needIdx.push(i);
  }
  const srcPri = (s: string) => /币安|CoinDesk|Cointelegraph|The Block|Decrypt/i.test(s) ? 2 : 1;
  needIdx.sort((a, b) => {
    const ia = out[a], ib = out[b];
    const pa = (ia.important ? 1e15 : 0) + srcPri(ia.source) * 1e13 + (ia.t || 0);
    const pb = (ib.important ? 1e15 : 0) + srcPri(ib.source) * 1e13 + (ib.t || 0);
    return pb - pa;
  });
  if (!needIdx.length || !env.AI) return out;

  const keys = needIdx.map((i) => keyOf(out[i].title, out[i].url));
  const cached = await Promise.all(keys.map((k) => env.STATE.get(k)));
  const todo: number[] = [];
  needIdx.forEach((i, j) => {
    const raw = cached[j];
    if (!raw) { todo.push(i); return; }
    try {
      const d = JSON.parse(raw) as { titleZh?: string; summaryZh?: string };
      if (validZh(d.titleZh || "")) {
        out[i].titleZh = d.titleZh;
        out[i].summaryZh = d.summaryZh || d.titleZh;
        return;
      }
    } catch { /* miss */ }
    todo.push(i);
  });

  const work: number[] = [];
  const per: Record<string, number> = {};
  for (const i of todo) {
    const src = out[i].source || "";
    if ((per[src] || 0) >= 4) continue;
    per[src] = (per[src] || 0) + 1;
    work.push(i);
    if (work.length >= MAX_NEW) break;
  }
  if (work.length < MAX_NEW) {
    for (const i of todo) {
      if (work.includes(i)) continue;
      work.push(i);
      if (work.length >= MAX_NEW) break;
    }
  }
  for (let i = 0; i < work.length; i += BATCH) {
    const chunk = work.slice(i, i + BATCH);
    await Promise.all(chunk.map(async (idx) => {
      const it = out[idx];
      const tr = await translateOne(env, it.title, it.excerpt || "");
      if (!tr) return;
      out[idx].titleZh = tr.titleZh;
      out[idx].summaryZh = tr.summaryZh;
      try {
        await env.STATE.put(keyOf(it.title, it.url), JSON.stringify(tr), { expirationTtl: TTL });
      } catch { /* */ }
    }));
  }
  return out;
}
