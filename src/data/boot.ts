import { getState, patch, saveLS } from "./store";
import { refreshSpotRest, refreshMacro, refreshFunding, refreshStocks, refreshCalendar, refreshNews, probeWorker, fetchDepth } from "./api";
import { startSpotSocket, startFutSocket, startBookTrades, type SockCtl } from "./ws";
import { scanRadar } from "./radar";

let spotCtl: SockCtl | null = null;
let futCtl: SockCtl | null = null;
let bookCtl: SockCtl | null = null;
let bookSym = "";

export function applyRoute() {
  const q = new URLSearchParams(location.search);
  const tab = q.get("tab");
  const symbol = q.get("symbol");
  const p: Partial<ReturnType<typeof getState>> = {};
  if (tab) p.tab = tab;
  if (symbol) p.symbol = symbol.toUpperCase();
  if (Object.keys(p).length) patch(p);
}

export function setRoute(tab: string, symbol?: string) {
  const u = new URL(location.href);
  u.searchParams.set("tab", tab);
  if (symbol) u.searchParams.set("symbol", symbol);
  history.replaceState(null, "", u.toString());
  patch({ tab, symbol: symbol || getState().symbol });
  saveLS();
  ensureBook();
}

export function ensureBook() {
  const sym = getState().symbol;
  if (bookSym === sym && bookCtl) return;
  bookCtl?.close();
  bookSym = sym;
  fetchDepth(sym).catch(() => {});
  bookCtl = startBookTrades(sym);
}

export async function boot() {
  applyRoute();
  const phone = window.innerWidth < 960;
  patch({ phone });
  window.addEventListener("resize", () => {
    const p = window.innerWidth < 960;
    if (p !== getState().phone) patch({ phone: p });
  });
  await probeWorker();
  await refreshSpotRest();
  spotCtl = startSpotSocket();
  futCtl = startFutSocket();
  ensureBook();
  refreshMacro();
  // 先给币安期货推送约 10 秒机会；只有还没有币安资金费时才用 OKX 填热力图，避免一启动就被标成 OKX。
  setTimeout(() => {
    const funding = getState().funding;
    const hasBn = Object.values(funding).some((f) => (f.source || "").includes("币安") && Date.now() - f.t < 120_000);
    if (!hasBn) refreshFunding();
  }, 10_000);
  refreshCalendar();
  refreshNews();
  refreshStocks();
  setInterval(() => {
    if (getState().spot.state !== "live") refreshSpotRest();
  }, 20000);
  setInterval(refreshMacro, 120000);
  setInterval(refreshFunding, 90_000);
  setInterval(() => { scanRadar(); }, 20000);
  setTimeout(scanRadar, 8000);
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js").catch(() => {});
  }
}

export function teardown() {
  spotCtl?.close(); futCtl?.close(); bookCtl?.close();
}
