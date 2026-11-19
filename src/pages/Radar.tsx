import { useStore } from "../lib/useStore";
import { fmtDateTime } from "../lib/format";
import { setRoute } from "../data/boot";

export default function Radar() {
  const st = useStore();
  return (
    <div className="phone-pad">
      <div className="card">
        <div className="card-h"><h2>机会雷达</h2><span className="stamp">{st.signals.length} 条信号</span></div>
        <p className="hint">本页扫描：多周期价格异动、放量、极端资金费、代币相对正股溢价/折价（超过 30% 视为异常映射并忽略）、自选 24h 大波动。不根据恐慌贪婪等情绪指数发信号。页面信号仅供观察，不是买卖建议，也不会自动下单。Telegram 推送更严：只发重要新闻（含币安上币/下架）和上述具体机会，带冷却与单轮条数上限，需配置仓库密钥或 Worker。</p>
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
