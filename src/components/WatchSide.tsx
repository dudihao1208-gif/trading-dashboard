import { useStore } from "../lib/useStore";
import { fmtPct, fmtPrice, chgClass } from "../lib/format";
import { setRoute } from "../data/boot";
import { MAJORS } from "../data/store";

export default function WatchSide() {
  const st = useStore();
  const list = [...st.watch, ...MAJORS.filter((s) => !st.watch.includes(s))];
  return (
    <div>
      <div className="card-h" style={{ padding: "10px 12px 4px" }}><h2>自选</h2></div>
      {list.map((s) => {
        const t = st.tickers[s];
        return (
          <div className="watch-item" key={s} onClick={() => setRoute("chart", s)} style={{ background: st.symbol === s ? "var(--gold-dim)" : undefined }}>
            <div>
              <div className="s">{s.replace("USDT", "")}</div>
              <div className="muted" style={{ fontSize: 11 }}>{fmtPrice(t?.c)}</div>
            </div>
            <div className={"num " + chgClass(t?.chg)} style={{ fontWeight: 700 }}>{fmtPct(t?.chg)}</div>
          </div>
        );
      })}
    </div>
  );
}
