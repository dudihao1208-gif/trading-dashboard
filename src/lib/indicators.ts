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
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      prev = s / period;
    } else {
      prev = v * k + prev * (1 - k);
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
  return rows.map((k) => ({
    time: Math.floor(Number(k[0]) / 1000),
    open: +k[1], high: +k[2], low: +k[3], close: +k[4],
    volume: +k[5], quote: +k[7], buyQ: +k[10],
  }));
}
