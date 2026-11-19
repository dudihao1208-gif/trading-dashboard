import { useEffect, useRef, useState } from "react";
import { createChart, AreaSeries, type IChartApi } from "lightweight-charts";
import { useStore } from "../lib/useStore";
import { fmtCountdown, fmtPrice, fmtTime, fmtUsd } from "../lib/format";
import { fetchRubik } from "../data/api";
import { setRoute } from "../data/boot";
import { nextFundingTime } from "../data/store";

const CCYS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"];

export default function Deriv() {
  const st = useStore();
  const [now, setNow] = useState(Date.now());
  const [ccy, setCcy] = useState("BTC");
  const [oiNote, setOiNote] = useState("加载中…");
  const [lsNote, setLsNote] = useState("加载中…");
  const [tkNote, setTkNote] = useState("加载中…");
  const oiRef = useRef<HTMLDivElement>(null);
  const lsRef = useRef<HTMLDivElement>(null);
  const tkRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const entries = Object.entries(st.funding)
    .filter(([s]) => s.endsWith("USDT"))
    .sort((a, b) => (b[1].oiUsd || 0) - (a[1].oiUsd || 0) || Math.abs(b[1].rate) - Math.abs(a[1].rate));
  const maxAbs = Math.max(0.0003, ...entries.map(([, f]) => Math.abs(f.rate)));

  useEffect(() => {
    let dead = false;
    (async () => {
      const oi = await fetchRubik("oi", ccy);
      const ls = await fetchRubik("ls", ccy);
      const tk = await fetchRubik("taker", ccy);
      if (dead) return;
      setOiNote(oi.ok ? oi.note : oi.note);
      setLsNote(ls.ok ? ls.note : ls.note);
      setTkNote(tk.ok ? tk.note : tk.note);
      drawArea(oiRef.current, oi.ok ? oi.pts.map((p) => ({ time: Math.floor(p.t / 1000), value: p.a })) : [], "#f0b90b");
      drawArea(lsRef.current, ls.ok ? ls.pts.map((p) => ({ time: Math.floor(p.t / 1000), value: p.a })) : [], "#60a5fa");
      drawArea(tkRef.current, tk.ok ? tk.pts.map((p) => ({ time: Math.floor(p.t / 1000), value: p.a })) : [], "#0ecb81");
    })();
    return () => { dead = true; };
  }, [ccy]);

  return (
    <div className="phone-pad">
      <div className="card">
        <div className="card-h">
          <h2>资金费率热力图</h2>
          <span className={"stamp" + (st.stamps.heat?.err ? " err" : "")}>{st.stamps.heat?.text || "—"}</span>
        </div>
        <p className="hint">优先直连币安全市场资金费；若几秒内不可用则自动改用 OKX。下一次普遍结算倒计时 {fmtCountdown((entries[0]?.[1].next || nextFundingTime()) - now)}（本地时区）。颜色越深表示费率绝对值越大，点击打开图表。</p>
        <div className="heat">
          {entries.map(([sym, f]) => {
            const a = Math.min(1, Math.abs(f.rate) / maxAbs);
            const bg = f.rate >= 0 ? `rgba(14,203,129,${0.12 + a * 0.65})` : `rgba(246,70,93,${0.12 + a * 0.65})`;
            return (
              <div className="heat-cell" key={sym} style={{ background: bg }} onClick={() => setRoute("chart", sym)}>
                <div className="s">{sym.replace("USDT", "")}</div>
                <div className="r">{(f.rate * 100).toFixed(4)}%</div>
                <div className="cd">{fmtCountdown((f.next || nextFundingTime()) - now)}</div>
              </div>
            );
          })}
          {!entries.length && <div className="empty">资金费加载中</div>}
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>持仓量 / 多空 / 主动买卖</h2>
          <select value={ccy} onChange={(e) => setCcy(e.target.value)}>{CCYS.map((c) => <option key={c}>{c}</option>)}</select>
        </div>
        <p className="hint">持仓量趋势：{oiNote}</p>
        <div ref={oiRef} className="chart-box" style={{ height: 180, minHeight: 180 }} />
        <p className="hint" style={{ marginTop: 10 }}>多空账户比：{lsNote}</p>
        <div ref={lsRef} className="chart-box" style={{ height: 160, minHeight: 160 }} />
        <p className="hint" style={{ marginTop: 8 }}>主动买入量：{tkNote}</p>
        <div ref={tkRef} className="chart-box" style={{ height: 160, minHeight: 160 }} />
      </div>

      <div className="card">
        <div className="card-h"><h2>爆仓流水</h2><span className={"stamp" + (st.fut.state === "down" ? " err" : "")}>{st.fut.label}</span></div>
        {st.fut.state !== "live" && (
          <p className="hint">正在优先连接币安期货推送（全市场资金费与爆仓）。若几秒内没有数据（部分地区会被限制），自动改用 OKX，状态不会一直停在「连接中」。</p>
        )}
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>时间</th><th>交易对</th><th>方向</th><th className="r">价格</th><th className="r">名义</th></tr></thead>
            <tbody>
              {st.liqs.slice(0, 30).map((r, i) => (
                <tr key={i} onClick={() => setRoute("chart", r.s)}>
                  <td>{fmtTime(r.t)}</td><td>{r.s}</td>
                  <td className={r.side === "多" ? "down" : "up"}>{r.side}</td>
                  <td className="r">{fmtPrice(r.px)}</td>
                  <td className="r">{fmtUsd(r.usd)}</td>
                </tr>
              ))}
              {!st.liqs.length && <tr><td colSpan={5} className="empty">暂无爆仓记录</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function drawArea(el: HTMLDivElement | null, data: { time: number; value: number }[], color: string) {
  if (!el) return;
  el.innerHTML = "";
  if (!data.length) return;
  const chart: IChartApi = createChart(el, {
    layout: { background: { color: "#080c10" }, textColor: "#7a8491" },
    grid: { vertLines: { color: "#161c24" }, horzLines: { color: "#161c24" } },
    rightPriceScale: { borderColor: "#262d37" },
    timeScale: { borderColor: "#262d37", timeVisible: true },
    autoSize: true,
  });
  const s = chart.addSeries(AreaSeries, { lineColor: color, topColor: color + "55", bottomColor: color + "05" });
  s.setData(data as never);
  chart.timeScale().fitContent();
}
