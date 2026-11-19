export type MarginMode = "cross" | "isolated";
export type PosSide = "long" | "short";
export type OrderType = "market" | "limit";
export type Action = "open" | "close";

export type OrderIntent = {
  symbol: string;
  action: Action;
  side: PosSide;
  type: OrderType;
  qty: number;
  price?: number; // 限价
  postOnly?: boolean;
  tp?: number | null;
  sl?: number | null;
  reduceOnly?: boolean;
};

export type Preview = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  canOpenLong: number;
  canOpenShort: number;
  qty: number;
  notional: number;
  margin: number;
  fee: number;
  liq: number | null;
  mark: number;
  fillPrice: number | null;
  leverage: number;
  mode: MarginMode;
};

export type Position = {
  symbol: string;
  side: PosSide;
  qty: number;
  entry: number;
  margin: number;
  leverage: number;
  mode: MarginMode;
  liq: number;
  tp: number | null;
  sl: number | null;
  realized: number;
  feesPaid: number;
  fundingPaid: number;
  openedAt: number;
};

export type RestingOrder = {
  id: string;
  symbol: string;
  action: Action;
  side: PosSide;
  type: OrderType;
  qty: number;
  price: number;
  postOnly?: boolean;
  tp?: number | null;
  sl?: number | null;
  createdAt: number;
};

export type HistoryRow = {
  id: string;
  t: number;
  symbol: string;
  action: string;
  side: PosSide;
  qty: number;
  price: number;
  fee: number;
  pnl?: number;
  note: string;
};

export type PaperAccount = {
  wallet: number;       // 钱包余额（不含未实现）
  available: number;
  leverage: Record<string, number>; // 已生效杠杆
  mode: Record<string, MarginMode>;
  takerFee: number;
  makerFee: number;
  positions: Position[];
  orders: RestingOrder[];
  history: HistoryRow[];
};

export interface TradingExecutor {
  readonly kind: "sim" | "binance";
  preview(intent: OrderIntent, ctx: MarketCtx): Preview;
  submit(intent: OrderIntent, ctx: MarketCtx): { ok: boolean; message: string };
  cancel(id: string): { ok: boolean; message: string };
  setLeverage(symbol: string, lev: number, max: number): { ok: boolean; message: string };
  setMode(symbol: string, mode: MarginMode): { ok: boolean; message: string };
  attachTPSL(symbol: string, side: PosSide, tp: number | null, sl: number | null): { ok: boolean; message: string };
  snapshot(): PaperAccount;
}

export type MarketCtx = {
  mark: number;
  last?: number;
  bids: { p: number; q: number }[];
  asks: { p: number; q: number }[];
  fundingRate?: number;
  nextFunding?: number;
};
