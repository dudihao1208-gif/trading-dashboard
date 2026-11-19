import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/useStore";
import { fmtPrice, fmtPct, chgClass } from "../lib/format";
import { toast } from "../data/store";
import { loadRules, type SymbolRules, priceDecimals, qtyDecimals, roundQty, roundToTick } from "../data/exchangeRules";
import { fetchFutDepth, fetchMarkPrice } from "../data/klines";
import { SimExecutor, loadAccount, levOf, modeOf, uPnL, roe, canOpen, DEFAULT_WALLET } from "./engine";
import type { Action, MarginMode, MarketCtx, OrderIntent, PosSide, Preview } from "./types";

function fmtLiq(liq: number | null | undefined, pd: number, lev: number, mode: string) {
  if (liq == null || !Number.isFinite(liq)) return "—";
  if (liq <= 0) return mode === "cross" ? "接近 0（全仓缓冲充足）" : "0";
  return liq.toFixed(pd);
}

export function usePaper() {
  const [rev, setRev] = useState(0);
  const execRef = useRef<SimExecutor | null>(null);
  const rulesRef = useRef<Record<string, SymbolRules>>({});
  if (!execRef.current) {
    execRef.current = new SimExecutor(loadAccount(), (s) => rulesRef.current[s] || {
      symbol: s, tickSize: 0.01, stepSize: 0.001, minQty: 0.001, maxQty: 1e9,
      minNotional: 5, floorNotional: 100, pricePrecision: 2, quantityPrecision: 3,
      contractType: "", status: "TRADING", maxLeverage: 50, mmr: 0.01, src: "待加载", at: 0,
    });
  }
  return { exec: execRef.current, rulesRef, bump: () => setRev((n) => n + 1), rev };
}

export default function PaperPanel({ symbol, onLines }: { symbol: string; onLines?: (lines: { id: string; price: number; color: string; title: string }[]) => void }) {
  const st = useStore();
  const { exec, rulesRef, bump, rev } = usePaper();
  const acc = exec.snapshot();
  const [rules, setRules] = useState<SymbolRules | null>(rulesRef.current[symbol] || null);
  const [ctx, setCtx] = useState<MarketCtx>({ mark: 0, bids: [], asks: [], last: st.tickers[symbol]?.c });
  const [type, setType] = useState<"market" | "limit">("market");
  const [qty, setQty] = useState("");
  const [limit, setLimit] = useState("");
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [postOnly, setPostOnly] = useState(false);
  const [unit, setUnit] = useState<"coin" | "usdt">("coin");
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState<null | { intent: OrderIntent; label: string }>(null);
  const [levOpen, setLevOpen] = useState(false);
  const [levDraft, setLevDraft] = useState(0);
  const [tab, setTab] = useState<"pos" | "ord" | "his">("pos");
  const lastFunding = useRef<Record<string, string>>({});

  useEffect(() => {
    let stop = false;
    (async () => {
      const r = await loadRules(symbol);
      if (stop) return;
      rulesRef.current[symbol] = r;
      setRules(r);
    })();
    return () => { stop = true; };
  }, [symbol]);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const [mk, depth] = await Promise.all([fetchMarkPrice(symbol), fetchFutDepth(symbol, 20)]);
      if (stop) return;
      const mark = mk?.mark || st.tickers[symbol]?.c || 0;
      const next: MarketCtx = {
        mark, last: st.tickers[symbol]?.c, fundingRate: mk?.rate, nextFunding: mk?.next,
        bids: depth?.bids || st.book.bids, asks: depth?.asks || st.book.asks,
      };
      setCtx(next);
      const changed = exec.tick((s) => s === symbol ? next : { mark: st.tickers[s]?.c || 0, bids: [], asks: [] });
      if (mk?.next && mk.rate) {
        const key = symbol + ":" + mk.next;
        if (mk.next < Date.now() && lastFunding.current[symbol] !== key) {
          lastFunding.current[symbol] = key;
          exec.applyFunding(symbol, mk.rate, mark);
        }
      }
      if (changed) bump();
    };
    tick();
    const t = window.setInterval(tick, 2500);
    return () => { stop = true; clearInterval(t); };
  }, [symbol, rev]);

  const appliedLev = levOf(acc, symbol);
  const mode = modeOf(acc, symbol);
  const mark = ctx.mark || st.tickers[symbol]?.c || 0;
  const qtyNum = (() => {
    const n = +qty;
    if (!Number.isFinite(n) || n <= 0 || !rules) return 0;
    if (unit === "usdt") return roundQty(n / (type === "limit" && +limit ? +limit : mark || 1), rules.stepSize);
    return n;
  })();

  const intentBase = (action: Action, side: PosSide): OrderIntent => ({
    symbol, action, side, type, qty: qtyNum,
    price: type === "limit" ? +limit : undefined,
    postOnly: type === "limit" ? postOnly : false,
    tp: tp ? +tp : null, sl: sl ? +sl : null,
  });

  const previews = useMemo(() => {
    if (!rules) return null;
    return {
      openL: exec.preview(intentBase("open", "long"), ctx),
      openS: exec.preview(intentBase("open", "short"), ctx),
      closeL: exec.preview(intentBase("close", "long"), ctx),
      closeS: exec.preview(intentBase("close", "short"), ctx),
    };
  }, [rev, qty, limit, type, postOnly, tp, sl, unit, ctx.mark, ctx.asks, ctx.bids, rules, acc.available, appliedLev, mode]);

  useEffect(() => { setErr(""); }, [qty, limit, type, tp, sl, unit, symbol]);

  useEffect(() => {
    if (!onLines || !rules) return;
    const lines: { id: string; price: number; color: string; title: string }[] = [];
    for (const p of acc.positions.filter((x) => x.symbol === symbol)) {
      const col = p.side === "long" ? "#0ecb81" : "#f6465d";
      lines.push({ id: p.side + "-entry", price: p.entry, color: col, title: "开仓" });
      lines.push({ id: p.side + "-liq", price: p.liq, color: "#fb923c", title: "强平" });
      if (p.tp) lines.push({ id: p.side + "-tp", price: p.tp, color: "#60a5fa", title: "止盈" });
      if (p.sl) lines.push({ id: p.side + "-sl", price: p.sl, color: "#c084fc", title: "止损" });
    }
    onLines(lines);
  }, [rev, acc.positions, symbol, rules]);

  const askOpen = (action: Action, side: PosSide, label: string) => {
    if (!rules) return;
    const intent = intentBase(action, side);
    const pv = exec.preview(intent, ctx);
    if (!pv.ok) { setErr(pv.errors[0] || "无法下单"); return; }
    setConfirm({ intent, label });
  };

  const doConfirm = () => {
    if (!confirm) return;
    const r = exec.submit(confirm.intent, ctx);
    bump();
    setConfirm(null);
    if (r.ok) { setErr(""); toast(r.message); }
    else setErr(r.message);
  };

  const changeMode = (m: MarginMode) => {
    const r = exec.setMode(symbol, m);
    bump();
    if (!r.ok) setErr(r.message); else { setErr(""); toast(r.message); }
  };

  const applyLev = () => {
    if (!rules) return;
    const r = exec.setLeverage(symbol, levDraft, rules.maxLeverage);
    bump();
    setLevOpen(false);
    if (r.ok) toast(r.message); else setErr(r.message);
  };

  const pd = rules ? priceDecimals(rules.tickSize) : 2;
  const qd = rules ? qtyDecimals(rules.stepSize) : 3;
  const setPct = (pct: number, side: PosSide) => {
    if (!rules || !mark) return;
    const max = canOpen(acc, symbol, mark, rules, acc.takerFee);
    const q = roundQty(max * pct, rules.stepSize);
    setUnit("coin");
    setQty(q ? q.toFixed(qd) : "");
  };

  const pvShow: Preview | null = previews?.openL || null;
  const pos = acc.positions.filter((p) => p.symbol === symbol);

  return (
    <div className="paper">
      <div className="paper-head">
        <h2>模拟盘</h2>
        <span className="stamp">{rules ? rules.src : "加载规则中…"} · 非实盘</span>
      </div>
      <div className="paper-wallet">
        <div><b>钱包</b><span>{acc.wallet.toFixed(2)} USDT</span></div>
        <div><b>可用</b><span>{acc.available.toFixed(2)} USDT</span></div>
        <div><b>标记价</b><span>{fmtPrice(mark)}</span></div>
        <button type="button" className="btn" onClick={() => { setLevDraft(appliedLev); setLevOpen(true); }}>杠杆 {appliedLev}× 已生效</button>
        <div className="seg tight">
          <button type="button" className={mode === "cross" ? "on" : ""} onClick={() => changeMode("cross")}>全仓</button>
          <button type="button" className={mode === "isolated" ? "on" : ""} onClick={() => changeMode("isolated")}>逐仓</button>
        </div>
      </div>
      <div className="paper-can">
        可开多 {fmtPrice(previews?.openL.canOpenLong)} / 可开空 {fmtPrice(previews?.openS.canOpenShort)}
      </div>

      <div className="seg tight">
        <button type="button" className={type === "market" ? "on" : ""} onClick={() => setType("market")}>市价</button>
        <button type="button" className={type === "limit" ? "on" : ""} onClick={() => setType("limit")}>限价</button>
        <button type="button" className={unit === "coin" ? "on" : ""} onClick={() => setUnit("coin")}>{symbol.replace("USDT", "")}</button>
        <button type="button" className={unit === "usdt" ? "on" : ""} onClick={() => setUnit("usdt")}>USDT</button>
      </div>

      {type === "limit" && (
        <label className="paper-field">限价
          <input inputMode="decimal" value={limit} placeholder={`步进 ${rules?.tickSize ?? "—"}`}
            onChange={(e) => setLimit(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} />
        </label>
      )}
      {type === "limit" && (
        <label className="paper-check"><input type="checkbox" checked={postOnly} onChange={(e) => setPostOnly(e.target.checked)} /> 只挂单（Post Only）</label>
      )}
      <label className="paper-field">数量
        <input inputMode="decimal" value={qty} placeholder={`步进 ${rules?.stepSize ?? "—"}，最小名义 ${rules?.floorNotional ?? 100} USDT`}
          onChange={(e) => setQty(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} />
      </label>
      <div className="paper-pct">
        {[0.25, 0.5, 0.75, 1].map((p) => (
          <button type="button" key={p} onClick={() => setPct(p, "long")}>{p * 100}%</button>
        ))}
      </div>
      <div className="paper-tpsl">
        <label>止盈<input inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} placeholder="选填" /></label>
        <label>止损<input inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} placeholder="选填" /></label>
      </div>

      <div className="paper-preview">
        {!qtyNum && <div>填写数量查看预估</div>}
        {qtyNum > 0 && pvShow && (
          <>
            <div>预估成交 {fmtPrice(pvShow.fillPrice)} · 名义 {pvShow.notional.toFixed(2)} USDT</div>
            <div>保证金 {pvShow.margin.toFixed(2)} · 手续费 {pvShow.fee.toFixed(4)}</div>
            <div>预估强平价 {fmtLiq(pvShow.liq, pd, appliedLev, mode)}（按最小报价单位取整）</div>
          </>
        )}
        {(err || (qtyNum > 0 && pvShow && !pvShow.ok && pvShow.errors[0])) && (
          <div className="paper-err">{err || pvShow!.errors[0]}</div>
        )}
      </div>

      <div className="paper-actions">
        <button type="button" className="paper-btn long" disabled={!previews?.openL.ok} onClick={() => askOpen("open", "long", "开多")}>开多</button>
        <button type="button" className="paper-btn short" disabled={!previews?.openS.ok} onClick={() => askOpen("open", "short", "开空")}>开空</button>
        <button type="button" className="paper-btn" disabled={!previews?.closeL.ok} onClick={() => askOpen("close", "long", "平多")}>平多</button>
        <button type="button" className="paper-btn" disabled={!previews?.closeS.ok} onClick={() => askOpen("close", "short", "平空")}>平空</button>
      </div>

      <div className="seg tight">
        <button type="button" className={tab === "pos" ? "on" : ""} onClick={() => setTab("pos")}>仓位 {acc.positions.length}</button>
        <button type="button" className={tab === "ord" ? "on" : ""} onClick={() => setTab("ord")}>委托 {acc.orders.length}</button>
        <button type="button" className={tab === "his" ? "on" : ""} onClick={() => setTab("his")}>历史</button>
      </div>

      {tab === "pos" && (
        <div className="paper-list">
          {acc.positions.length === 0 && <div className="muted">暂无仓位</div>}
          {acc.positions.map((p) => {
            const m = p.symbol === symbol ? mark : (st.tickers[p.symbol]?.c || p.entry);
            const up = uPnL(p, m);
            return (
              <div className="paper-pos" key={p.symbol + p.side}>
                <div className="row">
                  <b>{p.symbol.replace("USDT", "")} 永续</b>
                  <span className={p.side === "long" ? "up" : "down"}>{p.side === "long" ? "多" : "空"} {p.leverage}× {p.mode === "cross" ? "全仓" : "逐仓"}</span>
                </div>
                <div className="grid">
                  <span>数量 {p.qty}</span>
                  <span>开仓 {fmtPrice(p.entry)}</span>
                  <span>标记 {fmtPrice(m)}</span>
                  <span>保证金 {p.margin.toFixed(2)}</span>
                  <span>强平 {fmtPrice(p.liq)}</span>
                  <span className={chgClass(up)}>未实现 {up.toFixed(2)}（ROE {fmtPct(roe(p, m))}）</span>
                  <span>资金费 {p.fundingPaid.toFixed(4)}</span>
                  <span>手续费 {p.feesPaid.toFixed(4)}</span>
                  <span>止盈 {p.tp ?? "—"} / 止损 {p.sl ?? "—"}</span>
                </div>
                <button type="button" className="btn" onClick={() => {
                  const r = exec.submit({ symbol: p.symbol, action: "close", side: p.side, type: "market", qty: p.qty }, p.symbol === symbol ? ctx : { mark: m, bids: [], asks: [] });
                  bump(); toast(r.message);
                }}>市价平仓</button>
              </div>
            );
          })}
        </div>
      )}
      {tab === "ord" && (
        <div className="paper-list">
          {acc.orders.length === 0 && <div className="muted">暂无挂单</div>}
          {acc.orders.map((o) => (
            <div className="paper-pos" key={o.id}>
              <div className="row"><b>{o.symbol}</b><span>{o.action === "open" ? (o.side === "long" ? "开多" : "开空") : (o.side === "long" ? "平多" : "平空")} 限价 {fmtPrice(o.price)} × {o.qty}</span></div>
              <button type="button" className="btn" onClick={() => { toast(exec.cancel(o.id).message); bump(); }}>撤单</button>
            </div>
          ))}
        </div>
      )}
      {tab === "his" && (
        <div className="paper-list">
          {acc.history.length === 0 && <div className="muted">暂无成交</div>}
          {acc.history.slice(0, 30).map((h) => (
            <div className="paper-pos" key={h.id}>
              <div className="row"><b>{h.action}</b><span>{new Date(h.t).toLocaleString("zh-CN", { hour12: false })}</span></div>
              <div>{h.symbol} {h.qty} @ {fmtPrice(h.price)} · 手续费 {h.fee.toFixed(4)}{h.pnl != null ? ` · 盈亏 ${h.pnl.toFixed(2)}` : ""}</div>
              <div className="muted">{h.note}</div>
            </div>
          ))}
        </div>
      )}

      {levOpen && rules && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>调整杠杆</h3>
            <p>当前已生效：<b>{appliedLev}×</b>。下方是草稿，点「应用」后才会生效。</p>
            <input type="range" min={1} max={rules.maxLeverage} value={levDraft} onChange={(e) => setLevDraft(+e.target.value)} />
            <input inputMode="numeric" value={levDraft} onChange={(e) => setLevDraft(+e.target.value || 0)} />
            <p className="muted">范围 1–{rules.maxLeverage}×。未点应用前不会改动仓位保证金。</p>
            <div className="paper-actions">
              <button type="button" className="btn" onClick={() => setLevOpen(false)}>取消</button>
              <button type="button" className="btn primary" disabled={levDraft < 1 || levDraft > rules.maxLeverage} onClick={applyLev}>应用 {levDraft}×</button>
            </div>
          </div>
        </div>
      )}

      {confirm && previews && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>确认{confirm.label}</h3>
            <p>{confirm.intent.symbol} {confirm.label} {confirm.intent.qty} 张，{confirm.intent.type === "market" ? "市价" : `限价 ${confirm.intent.price}`}，杠杆 {appliedLev}× {mode === "cross" ? "全仓" : "逐仓"}。</p>
            <p>预估强平价 {fmtLiq(exec.preview(confirm.intent, ctx).liq, pd, appliedLev, mode)}。本操作只在模拟盘中执行，不会连接币安实盘。</p>
            <div className="paper-actions">
              <button type="button" className="btn" onClick={() => setConfirm(null)}>取消</button>
              <button type="button" className="btn primary" onClick={doConfirm}>确认{confirm.label}</button>
            </div>
          </div>
        </div>
      )}
      <p className="disclaimer">模拟盘用真实币安盘口与标记价格撮合，数据保存在本机。不是投资建议，不会自动下单到交易所。</p>
    </div>
  );
}
export { DEFAULT_WALLET };
