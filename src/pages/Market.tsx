import { useMemo } from "react";
import { useStore } from "../lib/useStore";
import { MAJORS } from "../data/store";
import { fmtPrice, fmtPct, fmtUsd, chgClass, fmtTime } from "../lib/format";
import { setRoute } from "../data/boot";

export default function Market() {
  const st = useStore();
  const majors = MAJORS.map((s) => ({ s, t: st.tickers[s] }));
  const uni = useMemo(() => {
    return Object.keys(st.tickers)
      .filter((s) => s.endsWith("USDT") && (st.tickers[s].q || 0) >= 1_000_000)
      .map((s) => ({ s, ...st.tickers[s] }));
  }, [st.tickers]);
  const gain = [...uni].sort((a, b) => (b.chg || 0) - (a.chg || 0)).slice(0, 12);
  const lose = [...uni].sort((a, b) => (a.chg || 0) - (b.chg || 0)).slice(0, 12);
  const fng = st.macros.fng;
  return (
    <div className="phone-pad">
      <div className="chips">
        <div className="chipk"><span className="k">总市值</span><span className="v">{fmtUsd(st.macros.mcap)}</span></div>
        <div className="chipk"><span className="k">BTC 占比</span><span className="v">{st.macros.dom != null ? st.macros.dom.toFixed(1) + "%" : "—"}</span></div>
        <div className="chipk"><span className="k">24h 成交</span><span className="v">{fmtUsd(st.macros.vol)}</span></div>
        <div className="chipk" style={{ minWidth: 140 }}>
          <span className="k">恐慌贪婪</span>
          <span className={"v " + (fng != null ? (fng <= 45 ? "down" : fng >= 55 ? "up" : "") : "")}>
            {fng != null ? `${fng} · ${st.macros.fngClass || ""}` : "—"}
          </span>
          {fng != null && <div className="gauge"><b style={{ left: fng + "%" }} /></div>}
        </div>
      </div>
      <div className="card">
        <div className="card-h"><h2>主流币</h2><span className="stamp">{st.stamps.majors?.text || (st.spot.state === "live" ? "实时 · " + fmtTime(Date.now()) : "")}</span></div>
        <div className="grid-majors">
          {majors.map(({ s, t }) => (
            <div className="major" key={s} onClick={() => setRoute("chart", s)}>
              <div className="row1"><span className="sym">{s.replace("USDT", "")}<span className="muted"> /USDT</span></span><span className={"chg " + chgClass(t?.chg)}>{fmtPct(t?.chg)}</span></div>
              <div className="px">{fmtPrice(t?.c)}</div>
              <div className="meta"><span>24h 额 {fmtUsd(t?.q)}</span><span>高 {fmtPrice(t?.h)}</span></div>
            </div>
          ))}
        </div>
      </div>
      <div className="split">
        <Movers title="24h 涨幅" rows={gain} />
        <Movers title="24h 跌幅" rows={lose} />
      </div>
      <p className="disclaimer">本站仅提供公开行情观察与提醒，不构成投资建议，也不会自动下单。</p>
    </div>
  );
}

function Movers({ title, rows }: { title: string; rows: { s: string; c: number; chg: number; q?: number }[] }) {
  return (
    <div className="card">
      <div className="card-h"><h2>{title}</h2><span className="stamp">成交额 ≥ $1M</span></div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>交易对</th><th className="r">现价</th><th className="r">涨跌</th><th className="r">成交额</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.s} onClick={() => setRoute("chart", r.s)}>
                <td>{r.s}</td>
                <td className="r">{fmtPrice(r.c)}</td>
                <td className={"r " + chgClass(r.chg)}>{fmtPct(r.chg)}</td>
                <td className="r">{fmtUsd(r.q)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={4} className="empty">等待行情</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
