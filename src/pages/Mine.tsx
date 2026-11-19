import { useState } from "react";
import { useStore } from "../lib/useStore";
import { fmtDateTime, fmtPct, fmtPrice, chgClass } from "../lib/format";
import { getState, patch, saveLS, toast, type AlertRule } from "../data/store";
import { normalizeSym } from "../lib/format";
import { probeWorker, refreshNews } from "../data/api";

export default function Mine() {
  const st = useStore();
  const [sub, setSub] = useState<"alert" | "stocks" | "news" | "set">("alert");
  return (
    <div className="phone-pad">
      <div className="seg" style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {([["alert", "预警"], ["stocks", "美股代币"], ["news", "资讯日历"], ["set", "设置"]] as const).map(([k, l]) => (
          <button key={k} className={sub === k ? "on btn" : "btn"} onClick={() => setSub(k)}>{l}</button>
        ))}
      </div>
      {sub === "alert" && <AlertWizard />}
      {sub === "stocks" && <Stocks />}
      {sub === "news" && <NewsCal />}
      {sub === "set" && <Settings />}
      <p className="disclaimer">本站仅供观察，不构成投资建议，不自动交易。</p>
    </div>
  );
}

function AlertWizard() {
  const st = useStore();
  const [sym, setSym] = useState(st.symbol);
  const px = st.tickers[normalizeSym(sym)]?.c;
  const addWatch = () => {
    const s = normalizeSym(sym);
    if (!s) return;
    const watch = st.watch.includes(s) ? st.watch : [...st.watch, s];
    patch({ watch, symbol: s }); saveLS();
  };
  const setRule = (dir: "above" | "below", pct: number) => {
    const s = normalizeSym(sym);
    if (!s || px == null) return;
    const price = dir === "above" ? px * (1 + pct / 100) : px * (1 - pct / 100);
    const cur: AlertRule = st.alerts[s] || { symbol: s, above: null, below: null };
    const alerts = { ...st.alerts, [s]: { ...cur, symbol: s, [dir]: +price.toFixed(6) } };
    const watch = st.watch.includes(s) ? st.watch : [...st.watch, s];
    patch({ alerts, watch }); saveLS();
    toast(`已设置 ${s} ${dir === "above" ? "向上" : "向下"} ${fmtPrice(price)}`);
  };
  const requestNotify = () => {
    if (!("Notification" in window)) { toast("当前浏览器不支持通知"); return; }
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone;
    const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isiOS && !standalone) toast("iPhone 请先用 Safari 添加到主屏幕后再开启（iOS 16.4+）");
    Notification.requestPermission().then((p) => toast(p === "granted" ? "通知已开启（仅页面打开时）" : "未获得通知权限"));
  };
  return (
    <>
      <div className="card">
        <div className="card-h"><h2>预警向导</h2><span className="stamp">大按钮按现价百分比</span></div>
        <div className="wizard">
          <div style={{ display: "flex", gap: 8 }}>
            <input className="inp" style={{ flex: 1 }} value={sym} onChange={(e) => setSym(e.target.value)} placeholder="BTC 或 BTCUSDT" />
            <button className="btn primary" onClick={addWatch}>加入自选</button>
          </div>
          <div className="hint">现价 {fmtPrice(px)}。点下方按钮即以当前价加减百分比设阈值，也可稍后在列表里改数字。</div>
          <div className="wiz-grid">
            {[3, 5, 8].map((p) => <button key={"u"+p} className="wiz-btn up" onClick={() => setRule("above", p)}>向上 +{p}%</button>)}
            {[3, 5, 8].map((p) => <button key={"d"+p} className="wiz-btn down" onClick={() => setRule("below", p)}>向下 −{p}%</button>)}
          </div>
          <button className="btn" onClick={requestNotify}>开启浏览器通知</button>
          <p className="hint">页面打开时触及阈值会立即提醒。锁屏后台请用 Telegram 监控（仓库 Secrets 已可配置）。iPhone 需添加到主屏幕，iOS 16.4+。</p>
        </div>
      </div>
      <div className="card">
        <div className="card-h"><h2>自选与阈值</h2></div>
        {st.watch.map((s) => {
          const t = st.tickers[s]; const a = st.alerts[s] || { symbol: s, above: null, below: null };
          return (
            <div className="watch-item" key={s} style={{ display: "block" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div><div className="s">{s}</div><div className="muted">{fmtPrice(t?.c)} <span className={chgClass(t?.chg)}>{fmtPct(t?.chg)}</span></div></div>
                <button className="btn danger" onClick={() => { patch({ watch: st.watch.filter((x) => x !== s) }); saveLS(); }}>删除</button>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <label className="hint" style={{ flex: 1 }}>上破
                  <input className="inp" style={{ width: "100%" }} type="number" value={a.above ?? ""} placeholder="上限"
                    onChange={(e) => {
                      const v = e.target.value === "" ? null : Number(e.target.value);
                      patch({ alerts: { ...getState().alerts, [s]: { symbol: s, above: v, below: a.below } } }); saveLS();
                    }} />
                </label>
                <label className="hint" style={{ flex: 1 }}>下破
                  <input className="inp" style={{ width: "100%" }} type="number" value={a.below ?? ""} placeholder="下限"
                    onChange={(e) => {
                      const v = e.target.value === "" ? null : Number(e.target.value);
                      patch({ alerts: { ...getState().alerts, [s]: { symbol: s, above: a.above, below: v } } }); saveLS();
                    }} />
                </label>
              </div>
            </div>
          );
        })}
        {!st.watch.length && <div className="empty">还没有自选</div>}
      </div>
      <div className="card">
        <div className="card-h"><h2>本机提醒记录</h2></div>
        {st.alertLog.map((x, i) => <div key={i} className="news-item">{fmtDateTime(x.t)}　{x.msg}</div>)}
        {!st.alertLog.length && <div className="empty">暂无提醒</div>}
      </div>
    </>
  );
}

function Stocks() {
  const st = useStore();
  return (
    <div className="card">
      <div className="card-h"><h2>代币化美股对比</h2><span className={"stamp" + (st.stamps.stocks?.err ? " err" : "")}>{st.stamps.stocks?.text}</span></div>
      <p className="hint">对比 xStocks 代币与正股报价、溢价。正股来自仓库定期刷新的 public-data（Yahoo 无浏览器 CORS）。无正股的标的会标明。</p>
      <div className="stock-grid">
        {st.xstocks.map((x) => (
          <div className="stock-card" key={x.id}>
            <h3>{x.symbol}</h3>
            <div className="muted" style={{ fontSize: 12 }}>{x.name}</div>
            <div className="pair">
              <div className="leg">代币<b>${fmtPrice(x.price)} <span className={chgClass(x.chg)}>{fmtPct(x.chg)}</span></b></div>
              <div className="leg">正股{x.noUnder ? <b>无公开正股</b> : x.under?.price ? <b>${fmtPrice(x.under.price)} <span className={chgClass(x.under.chg)}>{fmtPct(x.under.chg)}</span></b> : <b>{x.under?.symbol || "—"} 待刷新</b>}</div>
            </div>
            <div style={{ marginTop: 8, fontSize: 13 }}>
              溢价 <b className={chgClass(x.premium)}>{x.premium == null ? "—" : fmtPct(x.premium)}</b>
            </div>
          </div>
        ))}
        {!st.xstocks.length && <div className="empty">代币列表加载中或暂不可用</div>}
      </div>
    </div>
  );
}

function NewsCal() {
  const st = useStore();
  const [imp, setImp] = useState("all");
  const now = Date.now() - 2 * 3600 * 1000;
  const evs = st.calendar.filter((e) => {
    const t = Date.parse(e.date);
    if (!Number.isFinite(t) || t < now) return false;
    if (imp !== "all" && e.impact !== imp) return false;
    return true;
  }).slice(0, 60);
  const impLabel: Record<string, string> = { High: "高", Medium: "中", Low: "低" };
  return (
    <>
      <div className="card">
        <div className="card-h"><h2>宏观日历</h2><span className="stamp">{st.calendarAt ? "更新 " + fmtDateTime(st.calendarAt) : st.stamps.cal?.text}</span></div>
        <div className="seg" style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          {([["all", "全部"], ["High", "高影响"], ["Medium", "中"], ["Low", "低"]] as const).map(([k, l]) => (
            <button key={k} className={imp === k ? "on btn" : "btn"} onClick={() => setImp(k)}>{l}</button>
          ))}
        </div>
        {evs.map((e, i) => (
          <div className="cal-item" key={i}>
            <span className={"imp " + (e.impact === "High" ? "high" : e.impact === "Medium" ? "med" : "")}>{impLabel[e.impact] || e.impact}</span>
            <span className="muted">{fmtDateTime(e.date)} · {e.country}</span>
            <div>{e.title}</div>
            <div className="muted">前值 {e.previous || "—"}　预测 {e.forecast || "—"}</div>
          </div>
        ))}
        {!evs.length && <div className="empty">暂无事件。若刚部署，等 GitHub Actions 刷新 public-data 后即可显示。</div>}
      </div>
      <div className="card">
        <div className="card-h"><h2>资讯</h2><span className="stamp">{st.stamps.news?.text}</span></div>
        {st.newsNote && <p className="hint">{st.newsNote}</p>}
        {st.news.map((n, i) => (
          <div className="news-item" key={i}>
            <a href={n.url} target="_blank" rel="noopener">{n.title}</a>
            <div className="m">{n.source} · {fmtDateTime(n.t)}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function Settings() {
  const st = useStore();
  const [url, setUrl] = useState(st.workerUrl);
  return (
    <div className="card">
      <div className="card-h"><h2>数据代理（可选）</h2></div>
      <p className="hint">填写已部署的 Cloudflare Worker 根地址后，可解锁持仓量历史、多空比、主动买卖和中文资讯。未填写时站点仍可使用现货、盘口、K 线和资金费热力。</p>
      <div style={{ display: "flex", gap: 8 }}>
        <input className="inp" style={{ flex: 1 }} placeholder="https://xxx.workers.dev" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="btn primary" onClick={async () => {
          patch({ workerUrl: url.trim().replace(/\/$/, "") }); saveLS();
          await probeWorker(); await refreshNews();
          toast(getState().workerOk ? "Worker 可用" : url.trim() ? "无法访问该 Worker" : "已清除 Worker");
        }}>保存</button>
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        状态：{st.workerUrl ? (st.workerOk === true ? "已连接" : st.workerOk === false ? "不可用" : "未检测") : "未配置（降级模式）"}
      </p>
    </div>
  );
}
