import { useState } from "react";
import ChartPane, { type ChartLine, type IndOn } from "../components/ChartPane";
import BookTrades from "../components/BookTrades";
import PaperPanel from "../paper/PaperPanel";
import { useStore } from "../lib/useStore";
import { normalizeSym } from "../lib/format";
import { patch, saveLS, MAJORS } from "../data/store";
import { setRoute, ensureBook } from "../data/boot";

const TFS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
const TFL: Record<string, string> = { "1m": "1分", "5m": "5分", "15m": "15分", "1h": "1时", "4h": "4时", "1d": "1日" };

export default function ChartPage() {
  const st = useStore();
  const [input, setInput] = useState(st.symbol);
  const [legend, setLegend] = useState("");
  const [lines, setLines] = useState<ChartLine[]>([]);
  const [inds, setInds] = useState<IndOn>({ ema20: true, ema50: true, ma: false, boll: true, macd: true, atr: true });
  const [paperOpen, setPaperOpen] = useState(true);
  const symbols = st.multi ? [st.symbol, ...st.watch.filter((s) => s !== st.symbol), ...MAJORS].filter((v, i, a) => a.indexOf(v) === i).slice(0, 4) : [st.symbol];

  const applySym = (raw: string) => {
    const s = normalizeSym(raw);
    if (!s) return;
    setInput(s);
    setRoute("chart", s);
    ensureBook();
  };
  const tog = (k: keyof IndOn) => setInds((s) => ({ ...s, [k]: !s[k] }));

  return (
    <div className={"chart-page" + (paperOpen ? " has-paper" : "")}>
      <div className="chart-toolbar">
        <input value={input} onChange={(e) => setInput(e.target.value)} onBlur={() => applySym(input)}
          onKeyDown={(e) => { if (e.key === "Enter") applySym(input); }} style={{ width: 120, textTransform: "uppercase" }} />
        <div className="tf">
          {TFS.map((t) => (
            <button type="button" key={t} className={st.tf === t ? "on" : ""} onClick={() => { patch({ tf: t }); saveLS(); }}>{TFL[t]}</button>
          ))}
        </div>
        {!st.phone && (
          <button type="button" className={"btn" + (st.multi ? " primary" : "")} onClick={() => patch({ multi: !st.multi })}>{st.multi ? "单图" : "四图"}</button>
        )}
        <button type="button" className={"btn" + (paperOpen ? " primary" : "")} onClick={() => setPaperOpen((v) => !v)}>模拟盘</button>
        <span className={"stamp" + (st.stamps.chart?.err ? " err" : "")}>{st.stamps.chart?.text}</span>
      </div>
      <div className="ind-bar">
        {([
          ["ema20", "EMA20"], ["ema50", "EMA50"], ["ma", "MA7/25/99"], ["boll", "BOLL"], ["macd", "MACD"], ["atr", "ATR"],
        ] as const).map(([k, l]) => (
          <button type="button" key={k} className={inds[k] ? "on" : ""} onClick={() => tog(k)}>{l}</button>
        ))}
        {legend && <span className="ind-legend">{legend}</span>}
      </div>
      <div className={"chart-grid " + (st.multi && !st.phone ? "x4" : "x1")}>
        {symbols.map((s) => (
          <ChartPane key={s + st.tf + (st.multi ? "m" : "s")} symbol={s} tf={st.tf} lines={s === st.symbol ? lines : []} inds={inds} onLegend={s === st.symbol ? setLegend : undefined} />
        ))}
      </div>
      {paperOpen && <PaperPanel symbol={st.symbol} onLines={setLines} />}
      {st.phone && <BookTrades tabs />}
    </div>
  );
}
