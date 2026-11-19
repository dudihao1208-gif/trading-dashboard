/** 与币安图表一致：首个值用前 period 根的 SMA 做种子，之后按标准 EMA 递推。 */
export function ema(values: number[], period: number): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  const k = 2 / (period + 1);
  let prev: number | undefined;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { out.push(undefined); continue; }
    if (prev == null) {
      if (i < period - 1) { out.push(undefined); continue; }
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) {
        if (!Number.isFinite(values[j])) { s = NaN; break; }
        s += values[j];
      }
      if (!Number.isFinite(s)) { out.push(undefined); continue; }
      prev = s / period;
    } else {
      prev = v * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

export function sma(values: number[], period: number): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { out.push(undefined); continue; }
    s += v;
    if (i >= period) s -= values[i - period];
    out.push(i >= period - 1 ? s / period : undefined);
  }
  return out;
}

export function boll(values: number[], period = 20, mult = 2) {
  const mid = sma(values, period);
  const upper: (number | undefined)[] = [];
  const lower: (number | undefined)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (mid[i] == null || i < period - 1) { upper.push(undefined); lower.push(undefined); continue; }
    let ss = 0;
    for (let j = i - period + 1; j <= i; j++) ss += (values[j] - (mid[i] as number)) ** 2;
    const sd = Math.sqrt(ss / period);
    upper.push((mid[i] as number) + mult * sd);
    lower.push((mid[i] as number) - mult * sd);
  }
  return { mid, upper, lower };
}

/** 真实波幅 ATR（Wilder，SMA 种子后递推）。不足 period 根不给出数值。 */
export function atr(highs: number[], lows: number[], closes: number[], period = 14): (number | undefined)[] {
  const trs: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) trs.push(highs[i] - lows[i]);
    else {
      const prev = closes[i - 1];
      trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - prev), Math.abs(lows[i] - prev)));
    }
  }
  const out: (number | undefined)[] = [];
  let prev: number | undefined;
  for (let i = 0; i < trs.length; i++) {
    if (i < period - 1) { out.push(undefined); continue; }
    if (prev == null) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += trs[j];
      prev = s / period;
    } else {
      prev = (prev * (period - 1) + trs[i]) / period;
    }
    out.push(prev);
  }
  return out;
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const e1 = ema(closes, fast);
  const e2 = ema(closes, slow);
  const dif: (number | undefined)[] = closes.map((_, i) =>
    e1[i] != null && e2[i] != null ? (e1[i] as number) - (e2[i] as number) : undefined
  );
  const defined: number[] = [];
  const idx: number[] = [];
  dif.forEach((v, i) => { if (v != null) { defined.push(v); idx.push(i); } });
  const sigRaw = ema(defined, signal);
  const sig: (number | undefined)[] = closes.map(() => undefined);
  const hist: (number | undefined)[] = closes.map(() => undefined);
  idx.forEach((i, j) => {
    sig[i] = sigRaw[j];
    if (dif[i] != null && sigRaw[j] != null) hist[i] = (dif[i] as number) - (sigRaw[j] as number);
  });
  return { macd: dif, signal: sig, hist };
}

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; buyQ: number; quote: number };

export function parseKlines(rows: (string | number)[][]): Candle[] {
  const map = new Map<number, Candle>();
  for (const k of rows) {
    const time = Math.floor(Number(k[0]) / 1000);
    if (!Number.isFinite(time)) continue;
    map.set(time, {
      time,
      open: +k[1], high: +k[2], low: +k[3], close: +k[4],
      volume: +k[5], quote: +(k[7] ?? 0), buyQ: +(k[10] ?? 0),
    });
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}
