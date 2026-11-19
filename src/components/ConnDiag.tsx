import { useState } from "react";
import { useStore } from "../lib/useStore";
import { runDiagnostics, formatDiag, type DiagRow } from "../data/diag";
import { toast } from "../data/store";

export default function ConnDiag() {
  const st = useStore();
  const [rows, setRows] = useState<DiagRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [copied, setCopied] = useState(false);

  const run = async () => {
    setBusy(true);
    setCopied(false);
    setRows([]);
    setProgress("开始检测…");
    try {
      const all = await runDiagnostics(st.workerUrl, (row, i, total) => {
        setRows((prev) => {
          const next = prev.slice();
          next[i] = row;
          return next;
        });
        setProgress(`正在检测 ${i + 1}/${total}：${row.name}（${row.result.startsWith("成功") ? "成功" : "失败"}）`);
      });
      setRows(all);
      setProgress("检测完成。请把结果复制发给开发者。");
    } catch (e) {
      setProgress("检测中断：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    const text = formatDiag(rows);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast("诊断结果已复制");
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
        toast("诊断结果已复制");
      } catch {
        toast("复制失败，请长按结果手动复制");
      }
    }
  };

  return (
    <div className="card">
      <div className="card-h"><h2>连接诊断</h2></div>
      <p className="hint">在这部手机上测试到币安期货/现货推送和代理的连通情况。每项最多等待约 10 秒。全部完成后点「复制结果」发给开发者，便于判断是代码问题还是当地网络限制。</p>
      <p className="hint">当前期货状态：{st.fut.label}{st.fut.detail ? `（${st.fut.detail}）` : ""}。热力图：{st.stamps.heat?.text || "尚未更新"}。</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0 12px" }}>
        <button className="btn primary" disabled={busy} onClick={run}>{busy ? "检测中…" : "开始检测"}</button>
        <button className="btn" disabled={!rows.length || busy} onClick={copy}>{copied ? "已复制" : "复制结果"}</button>
      </div>
      {progress && <p className="hint">{progress}</p>}
      {rows.map((r) => (
        <div className="diag-item" key={r.name + r.endpoint}>
          <div className="title">{r.name}　<span className={r.firstMsgMs != null || (r.result.startsWith("成功") && r.opened) ? "up" : "down"}>{r.result}</span></div>
          <div className="meta break-all">{r.endpoint}</div>
          <div className="meta">握手：{r.opened ? "成功" : "失败"}　首条消息：{r.firstMsgMs != null ? (r.firstMsgMs / 1000).toFixed(2) + " 秒" : "未收到"}</div>
          {r.closeCode != null && <div className="meta">关闭/状态码：{r.closeCode}{r.closeReason ? "，" + r.closeReason : ""}</div>}
          {r.error && <div className="meta">{r.error}</div>}
        </div>
      ))}
    </div>
  );
}
