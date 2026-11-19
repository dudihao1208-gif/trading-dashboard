export type DiagRow = {
  name: string;
  endpoint: string;
  opened: boolean;
  firstMsgMs: number | null;
  closeCode: number | null;
  closeReason: string;
  error: string;
  result: string;
};

const WS_WAIT = 10_000;

export const DIAG_TARGETS: { name: string; url: string; kind: "ws" | "http" }[] = [
  { name: "币安期货合并流", url: "wss://fstream.binance.com/stream?streams=!markPrice@arr@1s/!forceOrder@arr", kind: "ws" },
  { name: "币安期货单流", url: "wss://fstream.binance.com/ws/!markPrice@arr@1s", kind: "ws" },
  { name: "币安现货 Vision", url: "wss://data-stream.binance.vision/ws/!miniTicker@arr", kind: "ws" },
  { name: "币安现货官方", url: "wss://stream.binance.com:9443/ws/!miniTicker@arr", kind: "ws" },
  { name: "现货盘口合并流", url: "wss://data-stream.binance.vision/stream?streams=btcusdt@depth20@100ms/btcusdt@aggTrade", kind: "ws" },
];

function wsTest(name: string, url: string): Promise<DiagRow> {
  return new Promise((resolve) => {
    const started = Date.now();
    let opened = false;
    let firstMsgMs: number | null = null;
    let settled = false;
    let sock: WebSocket | null = null;
    const row = (): DiagRow => {
      const error = !opened ? "未能完成握手（可能被网络拦截或证书失败）" : firstMsgMs == null ? "握手成功但 10 秒内没有收到消息" : "";
      const result = firstMsgMs != null ? "成功：已连通并收到数据" : opened ? "失败：已连通但没有数据" : "失败：未连通";
      return { name, endpoint: url, opened, firstMsgMs, closeCode: null, closeReason: "", error, result };
    };
    const done = (extra: Partial<DiagRow>) => {
      if (settled) return;
      settled = true;
      try { sock?.close(); } catch { /* */ }
      resolve({ ...row(), ...extra });
    };
    try {
      sock = new WebSocket(url);
    } catch (e) {
      done({ opened: false, error: e instanceof Error ? e.message : String(e), result: "失败：浏览器拒绝连接" });
      return;
    }
    const timer = window.setTimeout(() => {
      done({ error: opened ? "握手成功但 10 秒内没有收到消息" : "10 秒内未完成握手", result: opened ? "失败：已连通但没有数据" : "失败：超时未连通" });
    }, WS_WAIT);
    sock.onopen = () => { opened = true; };
    sock.onmessage = () => {
      if (firstMsgMs == null) firstMsgMs = Date.now() - started;
      clearTimeout(timer);
      done({ opened: true, firstMsgMs, error: "", result: "成功：已连通并收到数据" });
    };
    sock.onerror = () => { /* 等 close */ };
    sock.onclose = (ev) => {
      clearTimeout(timer);
      if (settled) return;
      const reason = ev.reason || "（无原因说明）";
      const error = firstMsgMs != null ? "" : opened
        ? `握手成功后被关闭，代码 ${ev.code}，原因 ${reason}`
        : `未完成握手即关闭，代码 ${ev.code}，原因 ${reason}`;
      done({
        opened,
        firstMsgMs,
        closeCode: ev.code,
        closeReason: ev.reason || "",
        error,
        result: firstMsgMs != null ? "成功：已连通并收到数据" : opened ? "失败：已连通但没有数据" : "失败：未连通",
      });
    };
  });
}

async function httpTest(name: string, url: string): Promise<DiagRow> {
  const started = Date.now();
  try {
    const ctl = new AbortController();
    const t = window.setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    const ms = Date.now() - started;
    const ok = res.ok;
    return {
      name, endpoint: url, opened: ok, firstMsgMs: ms,
      closeCode: res.status, closeReason: res.statusText,
      error: ok ? "" : `HTTP ${res.status} ${res.statusText}`,
      result: ok ? `成功：HTTP ${res.status}，耗时 ${(ms / 1000).toFixed(2)} 秒` : `失败：HTTP ${res.status} ${res.statusText}`,
    };
  } catch (e) {
    const ms = Date.now() - started;
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name, endpoint: url, opened: false, firstMsgMs: ms,
      closeCode: null, closeReason: "",
      error: msg, result: "失败：" + msg,
    };
  }
}

export async function runDiagnostics(workerUrl: string, onRow?: (row: DiagRow, index: number, total: number) => void): Promise<DiagRow[]> {
  const targets = [...DIAG_TARGETS];
  if (workerUrl) {
    targets.push({ name: "Cloudflare Worker 健康检查", url: workerUrl.replace(/\/$/, "") + "/health", kind: "http" });
  }
  const rows: DiagRow[] = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const row = t.kind === "http" ? await httpTest(t.name, t.url) : await wsTest(t.name, t.url);
    rows.push(row);
    onRow?.(row, i, targets.length);
  }
  return rows;
}

export function formatDiag(rows: DiagRow[]): string {
  const now = new Date().toLocaleString("zh-CN", { hour12: false });
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const standalone = typeof window !== "undefined" && (window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone);
  const lines = [
    "交易观察台连接诊断",
    `时间：${now}（设备本地时区）`,
    `独立到主屏幕：${standalone ? "是" : "否"}`,
    `浏览器：${ua}`,
    "",
  ];
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.name}`);
    lines.push(`   地址：${r.endpoint}`);
    lines.push(`   结果：${r.result}`);
    lines.push(`   握手：${r.opened ? "成功" : "失败"}`);
    lines.push(`   首条消息：${r.firstMsgMs != null ? (r.firstMsgMs / 1000).toFixed(2) + " 秒" : "未收到"}`);
    if (r.closeCode != null) lines.push(`   关闭/状态码：${r.closeCode}${r.closeReason ? "，" + r.closeReason : ""}`);
    if (r.error) lines.push(`   说明：${r.error}`);
    lines.push("");
  });
  return lines.join("\n").trim() + "\n";
}
