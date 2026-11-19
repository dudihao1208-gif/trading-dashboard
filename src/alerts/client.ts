import { workerOn, getState, toast } from "../data/store";

const LS = "td-alert-token";

export type ServerAlert = {
  id: string;
  symbol: string;
  kind: "above" | "below" | "chgUp" | "chgDown";
  value: number;
  persist: "once" | "repeat";
  enabled: boolean;
  createdAt: number;
  refPrice?: number;
  lastFired?: number;
  note?: string;
};

export function alertToken(): string {
  try { return localStorage.getItem(LS) || ""; } catch { return ""; }
}
export function setAlertToken(t: string) {
  try { if (t) localStorage.setItem(LS, t); else localStorage.removeItem(LS); } catch { /* */ }
}

function root() {
  return (getState().workerUrl || "").replace(/\/$/, "");
}

async function req(path: string, init: RequestInit = {}) {
  const base = root();
  if (!base) throw new Error("未配置 Worker");
  const token = alertToken();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as Record<string, string> || {}) };
  if (token) headers.Authorization = "Bearer " + token;
  const r = await fetch(base + path, { ...init, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || "HTTP " + r.status);
  return data;
}

export async function requestPairCode() {
  if (!workerOn()) { toast("请先在设置里填写 Worker 地址"); return; }
  const d = await req("/alerts/pair", { method: "POST", body: "{}" });
  toast("配对码已发到 Telegram，请在 10 分钟内输入");
  return d as { ok: boolean };
}

export async function confirmPair(code: string) {
  const d = await req("/alerts/confirm", { method: "POST", body: JSON.stringify({ code: code.trim() }) }) as { token?: string };
  if (d.token) { setAlertToken(d.token); toast("价格提醒已绑定 Telegram"); }
  return d;
}

export async function listAlerts(): Promise<ServerAlert[]> {
  if (!alertToken()) return [];
  const d = await req("/alerts") as { items?: ServerAlert[] };
  return d.items || [];
}

export async function saveAlert(a: Partial<ServerAlert> & { symbol: string; kind: ServerAlert["kind"]; value: number }): Promise<ServerAlert[]> {
  const d = await req("/alerts", { method: "POST", body: JSON.stringify(a) }) as { items?: ServerAlert[] };
  return d.items || [];
}

export async function deleteAlert(id: string): Promise<ServerAlert[]> {
  const d = await req("/alerts?id=" + encodeURIComponent(id), { method: "DELETE" }) as { items?: ServerAlert[] };
  return d.items || [];
}

export async function sendTestAlert() {
  await req("/alerts/test", { method: "POST", body: "{}" });
  toast("已请求发送测试提醒");
}
