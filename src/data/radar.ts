import { addSignal, getState, MAJORS, type Signal } from "./store";
import { fmtPrice, fmtPct } from "../lib/format";

const COOL = 30 * 60 * 1000;
const fired = new Map<string, number>();
function cool(id: string, ms = COOL) {
  const t = fired.get(id);
  return t != null && Date.now() - t < ms;
}
function fire(s: Signal, ms = COOL) {
  if (cool(s.id, ms)) return;
  fired.set(s.id, Date.now());
  addSignal(s);
}

function chgSince(sym: string, ms: number): number | null {
  const arr = getState().snaps[sym];
  const last = getState().tickers[sym];
  if (!last || !arr?.length) return null;
  const target = last.t - ms;
  let best = arr[0];
  for (const s of arr) {
    if (s.t <= target) best = s;
    else break;
  }
  if (last.t - best.t < ms * 0.5) return null;
  return (last.c / best.p - 1) * 100;
}

/** 基于 miniTicker 快照的多周期异动 + 资金费 / 溢价 / 自选（不推送情绪指数） */
export function scanRadar() {
  const st = getState();
  const uni = Object.keys(st.tickers).filter((s) => s.endsWith("USDT") && (st.tickers[s].q || 0) > 2_000_000);
  const tfs: { key: string; ms: number; th: number }[] = [
    { key: "1m", ms: 60_000, th: 1.8 },
    { key: "5m", ms: 5 * 60_000, th: 3.0 },
    { key: "15m", ms: 15 * 60_000, th: 5.0 },
    { key: "1h", ms: 60 * 60_000, th: 7.0 },
  ];
  for (const sym of uni.slice(0, 80)) {
    for (const tf of tfs) {
      const chg = chgSince(sym, tf.ms);
      if (chg == null || Math.abs(chg) < tf.th) continue;
      const dir = chg > 0 ? "拉升" : "跳水";
      fire({
        id: `${sym}:${tf.key}:${chg > 0 ? "up" : "dn"}`,
        kind: `${tf.key}异动`,
        title: `${sym} ${tf.key} ${dir} ${fmtPct(chg)}`,
        detail: `现价 ${fmtPrice(st.tickers[sym].c)}，24h ${fmtPct(st.tickers[sym].chg)}`,
        symbol: sym,
        hot: Math.abs(chg) >= tf.th * 1.4,
        t: Date.now(),
      });
    }
    // 成交额滚动增量：与 20 分钟前的 24h 成交额之差粗略代表近期量能
    const arr = st.snaps[sym] || [];
    if (arr.length >= 6) {
      const last = arr[arr.length - 1];
      const prev = arr[Math.max(0, arr.length - 8)];
      const dq = last.q - prev.q;
      const ago = arr.filter((s) => last.t - s.t > 15 * 60_000 && last.t - s.t < 50 * 60_000);
      if (ago.length >= 2 && dq > 0) {
        const rates = [];
        for (let i = 1; i < ago.length; i++) {
          const dt = (ago[i].t - ago[i - 1].t) / 60000;
          if (dt > 0) rates.push((ago[i].q - ago[i - 1].q) / dt);
        }
        rates.sort((a, b) => a - b);
        const med = rates[Math.floor(rates.length / 2)];
        const cur = dq / Math.max(1, (last.t - prev.t) / 60000);
        if (med > 0 && cur / med >= 4) {
          fire({
            id: `${sym}:vol:${Math.floor(Date.now() / 600000)}`,
            kind: "放量",
            title: `${sym} 近端成交量约为常态的 ${(cur / med).toFixed(1)} 倍`,
            detail: `现价 ${fmtPrice(st.tickers[sym].c)}，24h ${fmtPct(st.tickers[sym].chg)}`,
            symbol: sym,
            hot: cur / med >= 6,
            t: Date.now(),
          });
        }
      }
    }
  }

  for (const [sym, f] of Object.entries(st.funding)) {
    if (Math.abs(f.rate) >= 0.001) {
      fire({
        id: `${sym}:fund:${f.rate > 0 ? "pos" : "neg"}`,
        kind: "资金费",
        title: `${sym} 资金费率 ${ (f.rate * 100).toFixed(4) }%`,
        detail: `来源 ${f.source}。正费率多头付空头，负费率相反。`,
        symbol: sym,
        hot: Math.abs(f.rate) >= 0.003,
        t: Date.now(),
      }, 3 * 3600 * 1000);
    }
  }

  for (const x of st.xstocks) {
    if (x.noUnder || x.premium == null || Math.abs(x.premium) < 5 || Math.abs(x.premium) > 30) continue;
    fire({
      id: `prem:${x.symbol}:${x.premium > 0 ? "hi" : "lo"}`,
      kind: "溢价",
      title: `${x.symbol} 相对正股 ${x.premium > 0 ? "溢价" : "折价"} ${fmtPct(x.premium)}`,
      detail: `代币 ${fmtPrice(x.price)}，正股 ${x.under?.price ? fmtPrice(x.under.price) : "—"}`,
      symbol: x.symbol,
      t: Date.now(),
    }, 12 * 3600 * 1000);
  }

  for (const sym of st.watch.length ? st.watch : MAJORS) {
    const t = st.tickers[sym];
    if (!t) continue;
    if (Math.abs(t.chg) >= 8) {
      fire({
        id: `${sym}:d24`,
        kind: "自选",
        title: `${sym} 24h ${fmtPct(t.chg)}`,
        detail: `现价 ${fmtPrice(t.c)}`,
        symbol: sym,
        hot: Math.abs(t.chg) >= 12,
        t: Date.now(),
      }, 12 * 3600 * 1000);
    }
  }
}
