import { useStore } from "../lib/useStore";
import { fmtDateTime } from "../lib/format";
import { setRoute } from "../data/boot";

export default function Radar() {
  const st = useStore();
  return (
    <div className="phone-pad">
      <div className="card">
        <div className="card-h"><h2>机会雷达</h2><span className="stamp">{st.signals.length} 条信号</span></div>
        <p className="hint">根据实时行情自动扫描：多周期异动、放量、极端资金费、恐慌贪婪、代币溢价、自选大波动。这是观察信号，不是买卖建议，也不会自动下单。同样规则可由监控脚本推到 Telegram（需配置密钥，并有冷却防刷屏）。</p>
        {st.signals.map((s) => (
          <div className={"signal" + (s.hot ? " hot" : "")} key={s.id} onClick={() => s.symbol && setRoute("chart", s.symbol.endsWith("USDT") ? s.symbol : st.symbol)}>
            <div className="title"><span className="tag">{s.kind}</span>{s.title}</div>
            {s.detail && <div className="meta">{s.detail}</div>}
            <div className="when">{fmtDateTime(s.t)}</div>
          </div>
        ))}
        {!st.signals.length && <div className="empty">暂无信号。需要积累约 1–5 分钟快照后，短周期异动才会出现。</div>}
      </div>
    </div>
  );
}
