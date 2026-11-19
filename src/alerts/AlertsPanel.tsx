import { useEffect, useState } from "react";
import { useStore } from "../lib/useStore";
import { fmtPrice } from "../lib/format";
import { normalizeSym } from "../lib/format";
import { toast } from "../data/store";
import { alertToken, confirmPair, deleteAlert, listAlerts, requestPairCode, saveAlert, sendTestAlert, type ServerAlert } from "./client";

const KIND: { id: ServerAlert["kind"]; label: string }[] = [
  { id: "above", label: "价格涨到" },
  { id: "below", label: "价格跌到" },
  { id: "chgUp", label: "涨幅达到 %" },
  { id: "chgDown", label: "跌幅达到 %" },
];

export default function AlertsPanel() {
  const st = useStore();
  const [items, setItems] = useState<ServerAlert[]>([]);
  const [linked, setLinked] = useState(!!alertToken());
  const [code, setCode] = useState("");
  const [sym, setSym] = useState(st.symbol);
  const [kind, setKind] = useState<ServerAlert["kind"]>("above");
  const [value, setValue] = useState("");
  const [persist, setPersist] = useState<"once" | "repeat">("once");
  const [edit, setEdit] = useState<string | null>(null);
  const px = st.tickers[normalizeSym(sym)]?.c;

  const refresh = async () => {
    try { setItems(await listAlerts()); setLinked(!!alertToken()); }
    catch { /* 未绑定 */ }
  };
  useEffect(() => { refresh(); }, []);

  const submit = async () => {
    const s = normalizeSym(sym);
    const v = +value;
    if (!s) { toast("请填写交易对"); return; }
    if (!Number.isFinite(v) || v <= 0) { toast("请填写有效数值"); return; }
    try {
      const rows = await saveAlert({ id: edit || undefined, symbol: s, kind, value: v, persist, enabled: true, refPrice: px });
      setItems(rows); setEdit(null); setValue(""); toast(edit ? "已更新提醒" : "已添加提醒");
    } catch (e) { toast(e instanceof Error ? e.message : "保存失败"); }
  };

  return (
    <div>
      <div className="card">
        <div className="card-h"><h2>Telegram 价格提醒</h2><span className="stamp">{linked ? "已绑定" : "未绑定"}</span></div>
        {!linked && (
          <>
            <p className="hint">点下方按钮，机器人会把 6 位配对码发到你的 Telegram。输入后即可在服务器每分钟检查价格并推送（使用币安 www 标记价，美国 Worker 无法访问 fapi.binance.com 时的可用来源）。</p>
            <button type="button" className="btn primary" style={{ minHeight: 44 }} onClick={() => requestPairCode().catch((e) => toast(String(e.message || e)))}>发送配对码到 Telegram</button>
            <div className="wizard" style={{ marginTop: 10 }}>
              <input className="inp" inputMode="numeric" placeholder="输入 6 位配对码" value={code} onChange={(e) => setCode(e.target.value)} />
              <button type="button" className="btn" style={{ minHeight: 44 }} onClick={() => confirmPair(code).then(() => refresh()).catch((e) => toast(String(e.message || e)))}>确认绑定</button>
            </div>
          </>
        )}
        {linked && (
          <>
            <p className="hint">提醒保存在云端，每分钟用币安标记价格（www.binance.com，不走会 451 的官方 fapi）检查。现有新闻/机会规则不变：只推重大且 2 小时内的资讯。可自由增删改，不必写在配置文件里。</p>
            <div className="wizard">
              <input className="inp" value={sym} onChange={(e) => setSym(e.target.value)} placeholder="BTCUSDT" />
              <select className="inp" value={kind} onChange={(e) => setKind(e.target.value as ServerAlert["kind"])}>
                {KIND.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
              <input className="inp" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind.startsWith("chg") ? "例如 3 表示 3%" : `现价 ${fmtPrice(px)}`} />
              <div className="seg tight">
                <button type="button" className={persist === "once" ? "on" : ""} onClick={() => setPersist("once")}>只提醒一次</button>
                <button type="button" className={persist === "repeat" ? "on" : ""} onClick={() => setPersist("repeat")}>重复提醒</button>
              </div>
              <button type="button" className="btn primary" style={{ minHeight: 44 }} onClick={submit}>{edit ? "保存修改" : "添加提醒"}</button>
              {edit && <button type="button" className="btn" onClick={() => { setEdit(null); setValue(""); }}>取消编辑</button>}
              <button type="button" className="btn" onClick={() => sendTestAlert().catch((e) => toast(String(e.message || e)))}>发送测试提醒</button>
            </div>
          </>
        )}
      </div>
      {linked && (
        <div className="card">
          <div className="card-h"><h2>已设置的提醒</h2><span className="stamp">{items.length} 条</span></div>
          {items.length === 0 && <p className="muted">还没有提醒。</p>}
          {items.map((a) => (
            <div className="watch-item" key={a.id} style={{ display: "block" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <b>{a.symbol}</b>
                <span>{KIND.find((k) => k.id === a.kind)?.label} {a.kind.startsWith("chg") ? a.value + "%" : fmtPrice(a.value)} · {a.persist === "once" ? "一次" : "重复"}{a.enabled ? "" : " · 已停"}</span>
              </div>
              <div className="paper-actions" style={{ marginTop: 8 }}>
                <button type="button" className="btn" onClick={() => { setEdit(a.id); setSym(a.symbol); setKind(a.kind); setValue(String(a.value)); setPersist(a.persist); }}>编辑</button>
                <button type="button" className="btn danger" onClick={() => deleteAlert(a.id).then(setItems).catch((e) => toast(String(e.message || e)))}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
