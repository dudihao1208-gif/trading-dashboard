import { useState } from "react";
import ChartPane from "../components/ChartPane";
import BookTrades from "../components/BookTrades";
import { useStore } from "../lib/useStore";
import { normalizeSym } from "../lib/format";
import { patch, saveLS, MAJORS } from "../data/store";
import { setRoute, ensureBook } from "../data/boot";

const TFS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
const TFL: Record<string, string> = { "1m": "1分", "5m": "5分", "15m": "15分", "1h": "1时", "4h": "4时", "1d": "1日" };

export default function ChartPage() {
  const st = useStore();
  const [input, setInput] = useState(st.symbol);
  const symbols = st.multi ? [st.symbol, ...st.watch.filter((s) => s !== st.symbol), ...MAJORS].filter((v, i, a) => a.indexOf(v) === i).slice(0, 4) : [st.symbol];

  const applySym = (raw: string) => {
    const s = normalizeSym(raw);
    if (!s) return;
    setInput(s);
    setRoute("chart", s);
    ensureBook();
  };

  return (
    <div className="chart-page">
      <div className="chart-toolbar">
        <input value={input} onChange={(e) => setInput(e.target.value)} onBlur={() => applySym(input)}
          onKeyDown={(e) => { if (e.key === "Enter") applySym(input); }} style={{ width: 120, textTransform: "uppercase" }} />
        <div className="tf">
          {TFS.map((t) => (
            <button key={t} className={st.tf === t ? "on" : ""} onClick={() => { patch({ tf: t }); saveLS(); }}>{TFL[t]}</button>
          ))}
        </div>
        {!st.phone && (
          <button className={"btn" + (st.multi ? " primary" : "")} onClick={() => patch({ multi: !st.multi })}>{st.multi ? "单图" : "四图"}</button>
        )}
        <span className={"stamp" + (st.stamps.chart?.err ? " err" : "")}>{st.stamps.chart?.text}</span>
        <span className="muted" style={{ fontSize: 11 }}>黄 MA7 · 蓝 MA25 · 紫 MA99 · 下栏 MACD</span>
      </div>
      <div className={"chart-grid " + (st.multi && !st.phone ? "x4" : "x1")} style={{ flex: 1, minHeight: 0 }}>
        {symbols.map((s) => (
          <ChartPane key={s + st.tf + (st.multi ? "m" : "s")} symbol={s} tf={st.tf} />
        ))}
      </div>
      {st.phone && <BookTrades tabs />}
    </div>
  );
}
