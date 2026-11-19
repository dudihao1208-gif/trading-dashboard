import type { HistoryRow, MarginMode, MarketCtx, OrderIntent, PaperAccount, PosSide, Position, Preview, RestingOrder, TradingExecutor } from "./types";
import type { SymbolRules } from "../data/exchangeRules";
import { roundQty, roundToTick } from "../data/exchangeRules";

export const PAPER_KEY = "td-paper-v1";
export const DEFAULT_WALLET = 10_000;

export function emptyAccount(): PaperAccount {
  return {
    wallet: DEFAULT_WALLET, available: DEFAULT_WALLET,
    leverage: {}, mode: {}, takerFee: 0.0005, makerFee: 0.0002,
    positions: [], orders: [], history: [],
  };
}

export function loadAccount(): PaperAccount {
  try {
    const raw = localStorage.getItem(PAPER_KEY);
    if (!raw) return emptyAccount();
    const d = JSON.parse(raw) as PaperAccount;
    if (!d || typeof d.wallet !== "number") return emptyAccount();
    d.positions ||= []; d.orders ||= []; d.history ||= [];
    d.leverage ||= {}; d.mode ||= {};
    d.takerFee = d.takerFee ?? 0.0005;
    d.makerFee = d.makerFee ?? 0.0002;
    recalcAvailable(d);
    return d;
  } catch {
    return emptyAccount();
  }
}

export function saveAccount(acc: PaperAccount) {
  try { localStorage.setItem(PAPER_KEY, JSON.stringify(acc)); } catch { /* quota */ }
}

export function levOf(acc: PaperAccount, symbol: string) {
  return acc.leverage[symbol] || 1;
}
export function modeOf(acc: PaperAccount, symbol: string): MarginMode {
  return acc.mode[symbol] || "cross";
}

function usedMargin(acc: PaperAccount) {
  return acc.positions.reduce((s, p) => s + p.margin, 0);
}

export function recalcAvailable(acc: PaperAccount, marks?: Record<string, number>) {
  let upnl = 0;
  if (marks) {
    for (const p of acc.positions) {
      const m = marks[p.symbol];
      if (m) upnl += uPnL(p, m);
    }
  }
  acc.available = Math.max(0, acc.wallet - usedMargin(acc) + (upnl < 0 ? upnl : 0));
  return acc.available;
}

export function uPnL(p: Position, mark: number) {
  const dir = p.side === "long" ? 1 : -1;
  return dir * (mark - p.entry) * p.qty;
}

export function roe(p: Position, mark: number) {
  if (!p.margin) return 0;
  return (uPnL(p, mark) / p.margin) * 100;
}

export function liqPrice(p: Pick<Position, "side" | "entry" | "leverage" | "mode" | "qty" | "margin">, mmr: number, wallet?: number, tick = 0.01): number {
  const { side, entry, leverage: lev } = p;
  let liq: number;
  if (p.mode === "isolated") {
    liq = side === "long" ? entry * (1 - 1 / lev + mmr) : entry * (1 + 1 / lev - mmr);
  } else {
    // 全仓：用仓位保证金 + 钱包剩余可亏（粗略、单币种为主）
    const room = Math.max(p.margin, (wallet ?? p.margin));
    if (side === "long") liq = (p.entry * p.qty - room) / (p.qty * (1 - mmr));
    else liq = (p.entry * p.qty + room) / (p.qty * (1 + mmr));
  }
  if (!Number.isFinite(liq) || liq < 0) liq = 0;
  return roundToTick(liq, tick, side === "long" ? "up" : "down");
}

export function canOpen(acc: PaperAccount, symbol: string, mark: number, rules: SymbolRules, fee: number) {
  const lev = levOf(acc, symbol);
  recalcAvailable(acc, { [symbol]: mark });
  const px = mark * (1 + fee);
  const raw = px > 0 ? (acc.available * lev) / px : 0;
  return roundQty(Math.max(0, raw), rules.stepSize);
}

function walkBook(levels: { p: number; q: number }[], qty: number, taker: number): { avg: number; filled: number; fee: number } | null {
  let left = qty, cost = 0;
  for (const lv of levels) {
    if (left <= 0) break;
    const take = Math.min(left, lv.q);
    cost += take * lv.p;
    left -= take;
  }
  const filled = qty - left;
  if (filled <= 0) return null;
  const avg = cost / filled;
  return { avg, filled, fee: avg * filled * taker };
}

export function preview(acc: PaperAccount, intent: OrderIntent, ctx: MarketCtx, rules: SymbolRules): Preview {
  const errors: string[] = [];
  const warnings: string[] = [];
  const mark = ctx.mark || ctx.last || 0;
  const lev = levOf(acc, intent.symbol);
  const mode = modeOf(acc, intent.symbol);
  const feeR = intent.type === "limit" && intent.postOnly ? acc.makerFee : acc.takerFee;
  const canL = canOpen(acc, intent.symbol, mark, rules, feeR);
  const canS = canL;
  const qty = roundQty(intent.qty || 0, rules.stepSize);
  const ref = intent.type === "limit" && intent.price ? intent.price : (intent.side === "long"
    ? (ctx.asks[0]?.p || mark) : (ctx.bids[0]?.p || mark));
  const notional = qty * (ref || 0);
  const margin = lev > 0 ? notional / lev : notional;
  const fee = notional * feeR;
  let fillPrice: number | null = intent.type === "market" ? ref : (intent.price ?? null);
  let liq: number | null = null;

  if (!mark) errors.push("尚未拿到标记价格，请稍候再下单");
  if (rules.status && rules.status !== "TRADING") errors.push(`该合约当前状态为 ${rules.status}，不可交易`);
  if (!qty || qty <= 0) errors.push("请先填写数量");
  else {
    if (qty + 1e-12 < rules.minQty) errors.push(`数量低于最小下单量 ${rules.minQty}`);
    if (Math.abs(qty / rules.stepSize - Math.round(qty / rules.stepSize)) > 1e-6) {
      errors.push(`数量不符合步进 ${rules.stepSize}（已填写 ${intent.qty}）`);
    }
    if (notional + 1e-9 < rules.floorNotional) {
      errors.push(`名义价值 ${notional.toFixed(2)} USDT 低于最小下单额 ${rules.floorNotional} USDT`);
    }
  }
  if (intent.type === "limit") {
    if (!intent.price || intent.price <= 0) errors.push("请填写限价");
    else if (Math.abs(intent.price / rules.tickSize - Math.round(intent.price / rules.tickSize)) > 1e-6) {
      errors.push(`价格不符合最小报价单位 ${rules.tickSize}`);
    }
  }
  const pos = acc.positions.find((p) => p.symbol === intent.symbol && p.side === intent.side);
  if (intent.action === "close") {
    if (!pos) errors.push(intent.side === "long" ? "没有多头仓位可平" : "没有空头仓位可平");
    else if (qty - pos.qty > 1e-8) errors.push(`平仓数量超过持仓 ${pos.qty}`);
  } else {
    const need = margin + fee;
    if (need - acc.available > 1e-6) {
      errors.push(`可用余额不足（需要 ${need.toFixed(2)} USDT 保证金+手续费，可用 ${acc.available.toFixed(2)} USDT）`);
    }
    if (intent.tp != null && mark) {
      if (intent.side === "long" && intent.tp <= mark) errors.push("开多的止盈价应高于标记价格");
      if (intent.side === "short" && intent.tp >= mark) errors.push("开空的止盈价应低于标记价格");
    }
    if (intent.sl != null && mark) {
      if (intent.side === "long" && intent.sl >= mark) errors.push("开多的止损价应低于标记价格");
      if (intent.side === "short" && intent.sl <= mark) errors.push("开空的止损价应高于标记价格");
    }
  }
  if (intent.action === "open" && qty && ref) {
    liq = liqPrice({ side: intent.side, entry: ref, leverage: lev, mode, qty, margin }, rules.mmr, acc.wallet, rules.tickSize);
  } else if (pos) {
    liq = pos.liq;
  }

  return {
    ok: errors.length === 0 && qty > 0 && !!mark,
    errors, warnings, canOpenLong: canL, canOpenShort: canS,
    qty, notional, margin, fee, liq, mark, fillPrice, leverage: lev, mode,
  };
}

function hist(row: Omit<HistoryRow, "id">): HistoryRow {
  return { id: "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...row };
}

function applyFill(acc: PaperAccount, intent: OrderIntent, price: number, qty: number, fee: number, rules: SymbolRules, note: string) {
  const { symbol, side, action } = intent;
  const lev = levOf(acc, symbol);
  const mode = modeOf(acc, symbol);
  let pos = acc.positions.find((p) => p.symbol === symbol && p.side === side);
  let pnl = 0;
  if (action === "open") {
    const notional = price * qty;
    const margin = notional / lev;
    acc.wallet -= fee;
    if (!pos) {
      pos = { symbol, side, qty, entry: price, margin, leverage: lev, mode, liq: 0, tp: intent.tp ?? null, sl: intent.sl ?? null, realized: 0, feesPaid: fee, fundingPaid: 0, openedAt: Date.now() };
      pos.liq = liqPrice(pos, rules.mmr, acc.wallet, rules.tickSize);
      acc.positions.push(pos);
    } else {
      const tQty = pos.qty + qty;
      pos.entry = (pos.entry * pos.qty + price * qty) / tQty;
      pos.qty = tQty;
      pos.margin += margin;
      pos.feesPaid += fee;
      if (intent.tp != null) pos.tp = intent.tp;
      if (intent.sl != null) pos.sl = intent.sl;
      pos.liq = liqPrice(pos, rules.mmr, acc.wallet, rules.tickSize);
    }
  } else if (pos) {
    const closeQty = Math.min(qty, pos.qty);
    const dir = side === "long" ? 1 : -1;
    pnl = dir * (price - pos.entry) * closeQty;
    const rel = closeQty / pos.qty;
    acc.wallet += pnl - fee + pos.margin * rel;
    pos.margin *= (1 - rel);
    pos.qty -= closeQty;
    pos.realized += pnl;
    pos.feesPaid += fee;
    if (pos.qty <= 1e-10) acc.positions = acc.positions.filter((p) => p !== pos);
    else pos.liq = liqPrice(pos, rules.mmr, acc.wallet, rules.tickSize);
  }
  acc.history.unshift(hist({ t: Date.now(), symbol, action: action === "open" ? (side === "long" ? "开多" : "开空") : (side === "long" ? "平多" : "平空"), side, qty, price, fee, pnl: action === "close" ? pnl : undefined, note }));
  acc.history = acc.history.slice(0, 200);
  recalcAvailable(acc);
}

export class SimExecutor implements TradingExecutor {
  readonly kind = "sim" as const;
  acc: PaperAccount;
  rulesOf: (s: string) => SymbolRules;
  constructor(acc: PaperAccount, rulesOf: (s: string) => SymbolRules) {
    this.acc = acc;
    this.rulesOf = rulesOf;
  }

  snapshot() { return this.acc; }

  preview(intent: OrderIntent, ctx: MarketCtx) {
    return preview(this.acc, intent, ctx, this.rulesOf(intent.symbol));
  }

  submit(intent: OrderIntent, ctx: MarketCtx) {
    const rules = this.rulesOf(intent.symbol);
    const pv = preview(this.acc, intent, ctx, rules);
    if (!pv.ok) return { ok: false, message: pv.errors[0] || "下单失败" };
    if (intent.type === "limit") {
      const id = "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const order: RestingOrder = {
        id, symbol: intent.symbol, action: intent.action, side: intent.side, type: "limit",
        qty: pv.qty, price: intent.price!, postOnly: intent.postOnly, tp: intent.tp, sl: intent.sl, createdAt: Date.now(),
      };
      // post-only：若会立刻成交则拒绝
      const would = this.wouldFill(order, ctx);
      if (intent.postOnly && would) return { ok: false, message: "只挂单（Post Only）会立即成交，已拒绝" };
      if (would) {
        this.fillOrder(order, ctx, rules, "限价立即成交");
        saveAccount(this.acc);
        return { ok: true, message: `限价已成交 ${pv.qty}` };
      }
      this.acc.orders.push(order);
      saveAccount(this.acc);
      return { ok: true, message: "限价单已挂出" };
    }
    const book = intent.side === "long" ? ctx.asks : ctx.bids;
    const walked = walkBook(book, pv.qty, this.acc.takerFee);
    const price = walked?.avg || ctx.mark;
    const fee = walked?.fee ?? price * pv.qty * this.acc.takerFee;
    applyFill(this.acc, intent, price, walked?.filled || pv.qty, fee, rules, "市价吃单（真实盘口）");
    saveAccount(this.acc);
    return { ok: true, message: `${intent.action === "open" ? (intent.side === "long" ? "已开多" : "已开空") : (intent.side === "long" ? "已平多" : "已平空")} ${pv.qty} @ ${price}` };
  }

  cancel(id: string) {
    const n = this.acc.orders.length;
    this.acc.orders = this.acc.orders.filter((o) => o.id !== id);
    saveAccount(this.acc);
    return this.acc.orders.length < n ? { ok: true, message: "已撤销" } : { ok: false, message: "找不到该委托" };
  }

  setLeverage(symbol: string, lev: number, max: number) {
    const n = Math.floor(lev);
    if (n < 1 || n > max) return { ok: false, message: `杠杆须在 1–${max} 倍之间` };
    const pos = this.acc.positions.filter((p) => p.symbol === symbol);
    if (pos.length && n < Math.max(...pos.map((p) => p.leverage))) {
      // 允许调整，但需有足够保证金
    }
    this.acc.leverage[symbol] = n;
    for (const p of pos) {
      p.leverage = n;
      p.margin = (p.entry * p.qty) / n;
      p.liq = liqPrice(p, this.rulesOf(symbol).mmr, this.acc.wallet, this.rulesOf(symbol).tickSize);
    }
    recalcAvailable(this.acc);
    saveAccount(this.acc);
    return { ok: true, message: `杠杆 ${n}× 已生效` };
  }

  setMode(symbol: string, mode: MarginMode) {
    if (this.acc.positions.some((p) => p.symbol === symbol) && modeOf(this.acc, symbol) !== mode) {
      return { ok: false, message: "请先平掉该品种仓位再切换保证金模式" };
    }
    this.acc.mode[symbol] = mode;
    saveAccount(this.acc);
    return { ok: true, message: mode === "cross" ? "已切换为全仓" : "已切换为逐仓" };
  }

  attachTPSL(symbol: string, side: PosSide, tp: number | null, sl: number | null) {
    const p = this.acc.positions.find((x) => x.symbol === symbol && x.side === side);
    if (!p) return { ok: false, message: "没有对应仓位" };
    p.tp = tp; p.sl = sl;
    saveAccount(this.acc);
    return { ok: true, message: "止盈止损已更新" };
  }

  private wouldFill(o: RestingOrder, ctx: MarketCtx) {
    if (o.side === "long" && o.action === "open") return (ctx.asks[0]?.p ?? ctx.mark) <= o.price;
    if (o.side === "short" && o.action === "open") return (ctx.bids[0]?.p ?? ctx.mark) >= o.price;
    if (o.side === "long" && o.action === "close") return (ctx.bids[0]?.p ?? ctx.mark) >= o.price;
    return (ctx.asks[0]?.p ?? ctx.mark) <= o.price;
  }

  private fillOrder(o: RestingOrder, ctx: MarketCtx, rules: SymbolRules, note: string) {
    const feeR = o.postOnly ? this.acc.makerFee : this.acc.takerFee;
    const price = o.price;
    const fee = price * o.qty * feeR;
    applyFill(this.acc, o, price, o.qty, fee, rules, note);
    this.acc.orders = this.acc.orders.filter((x) => x.id !== o.id);
  }

  /** 用真实标记价/盘口撮合挂单、止盈止损与强平。 */
  tick(ctxOf: (symbol: string) => MarketCtx | null) {
    let changed = false;
    for (const o of [...this.acc.orders]) {
      const ctx = ctxOf(o.symbol);
      if (!ctx) continue;
      if (this.wouldFill(o, ctx)) {
        this.fillOrder(o, ctx, this.rulesOf(o.symbol), "限价触发成交");
        changed = true;
      }
    }
    for (const p of [...this.acc.positions]) {
      const ctx = ctxOf(p.symbol);
      if (!ctx?.mark) continue;
      const rules = this.rulesOf(p.symbol);
      const hitTp = p.tp != null && ((p.side === "long" && ctx.mark >= p.tp) || (p.side === "short" && ctx.mark <= p.tp));
      const hitSl = p.sl != null && ((p.side === "long" && ctx.mark <= p.sl) || (p.side === "short" && ctx.mark >= p.sl));
      const hitLiq = (p.side === "long" && ctx.mark <= p.liq) || (p.side === "short" && ctx.mark >= p.liq);
      if (hitTp || hitSl || hitLiq) {
        const px = hitLiq ? p.liq : (hitTp ? p.tp! : p.sl!);
        const fee = px * p.qty * this.acc.takerFee;
        applyFill(this.acc, { symbol: p.symbol, action: "close", side: p.side, type: "market", qty: p.qty }, px, p.qty, fee, rules, hitLiq ? "触发强平" : hitTp ? "触发止盈" : "触发止损");
        changed = true;
      }
    }
    if (changed) saveAccount(this.acc);
    return changed;
  }

  applyFunding(symbol: string, rate: number, mark: number) {
    let changed = false;
    for (const p of this.acc.positions.filter((x) => x.symbol === symbol)) {
      const pay = (p.side === "long" ? 1 : -1) * p.qty * mark * rate;
      p.fundingPaid += pay;
      this.acc.wallet -= pay;
      this.acc.history.unshift(hist({ t: Date.now(), symbol, action: "资金费", side: p.side, qty: p.qty, price: mark, fee: 0, pnl: -pay, note: `资金费率 ${(rate * 100).toFixed(4)}%` }));
      changed = true;
    }
    if (changed) { recalcAvailable(this.acc); saveAccount(this.acc); }
    return changed;
  }
}
