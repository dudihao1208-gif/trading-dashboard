export function fmtNum(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
}

export function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const x = Number(n);
  if (x >= 1000) return fmtNum(x, 2);
  if (x >= 1) return String(+x.toFixed(4));
  if (x >= 0.01) return String(+x.toFixed(5));
  return String(+x.toFixed(8));
}

export function fmtPct(n: number | null | undefined, signed = true): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return (signed && n > 0 ? "+" : "") + n.toFixed(2) + "%";
}

export function fmtUsd(n: number | null | undefined, prefix = true): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const x = Number(n);
  const abs = Math.abs(x);
  const s =
    abs >= 1e12 ? (x / 1e12).toFixed(2) + "T" :
    abs >= 1e9 ? (x / 1e9).toFixed(2) + "B" :
    abs >= 1e6 ? (x / 1e6).toFixed(2) + "M" :
    abs >= 1e3 ? (x / 1e3).toFixed(1) + "K" :
    x.toFixed(0);
  return prefix ? "$" + s : s;
}

export function fmtQty(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const x = Number(n);
  if (x >= 1000) return fmtUsd(x, false);
  if (x >= 1) return x.toFixed(4);
  return x.toFixed(6);
}

/** 浏览器本地时区（用户在罗马即为罗马时间） */
export function fmtTime(ts: number | Date | string | null | undefined, withSec = true): string {
  if (ts == null || ts === "") return "—";
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: withSec ? "2-digit" : undefined,
  });
}

export function fmtDateTime(ts: number | Date | string | null | undefined): string {
  if (ts == null || ts === "") return "—";
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function fmtCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "结算中";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function chgClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "";
  return n > 0 ? "up" : "down";
}

export function baseOf(sym: string): string {
  return sym.replace(/USDT$|USDC$|BUSD$/, "");
}

export function normalizeSym(s: string): string {
  s = (s || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return "";
  if (!/(USDT|USDC|BUSD)$/.test(s)) s += "USDT";
  return s;
}

/** 更新时间戳；超过 freshMs 则标记已过期 */
export function ageStamp(at?: string | number | null, freshMs = 6 * 3600_000, prefix = "更新"): { text: string; stale: boolean } {
  if (at == null || at === "" || at === 0) return { text: "尚无更新", stale: true };
  const t = typeof at === "number" ? at : Date.parse(String(at));
  if (!Number.isFinite(t)) return { text: "尚无更新", stale: true };
  const stale = Date.now() - t > freshMs;
  return { text: `${prefix} ${fmtDateTime(t)}${stale ? " · 已过期" : ""}`, stale };
}
