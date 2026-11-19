import { useEffect, useRef } from "react";
import {
  createChart, CandlestickSeries, LineSeries, HistogramSeries,
  type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp, LineStyle,
} from "lightweight-charts";
import { loadKlines, fetchLastFutKline, fetchMarkPrice, type KlineSource } from "../data/klines";
import { FUT_WS, SPOT_WS, setStamp } from "../data/store";
import { atr, boll, ema, macd, type Candle } from "../lib/indicators";

export type ChartLine = { id: string; price: number; color: string; title: string };
export type IndOn = { ema20: boolean; ema50: boolean; ma: boolean; boll: boolean; macd: boolean; atr: boolean };

const DEFAULT_ON: IndOn = { ema20: true, ema50: true, ma: false, boll: true, macd: true, atr: true };

type Props = { symbol: string; tf: string; lines?: ChartLine[]; inds?: IndOn; onLegend?: (s: string) => void };

export default function ChartPane({ symbol, tf, lines, inds = DEFAULT_ON, onLegend }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const api = useRef<ChartApi | null>(null);
  const lastBars = useRef<Candle[]>([]);
  const source = useRef<KlineSource>("futures-last");
  const priceLines = useRef<IPriceLine[]>([]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: { background: { color: "#080c10" }, textColor: "#7a8491" },
      grid: { vertLines: { color: "#161c24" }, horzLines: { color: "#161c24" } },
      rightPriceScale: { borderColor: "#262d37" },
      timeScale: { borderColor: "#262d37", timeVisible: true, secondsVisible: false },
      crosshair: { horzLine: { labelBackgroundColor: "#2b3139" }, vertLine: { labelBackgroundColor: "#2b3139" } },
      autoSize: true,
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#0ecb81", downColor: "#f6465d", borderUpColor: "#0ecb81", borderDownColor: "#f6465d",
      wickUpColor: "#0ecb81", wickDownColor: "#f6465d",
    }, 0);
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" } }, 0);
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });
    const mkLine = (color: string, scale = 0) => chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceScaleId: scale === 1 ? "macd" : undefined }, scale as 0 | 1);
    const ema20 = mkLine("#f0b90b");
    const ema50 = mkLine("#3b82f6");
    const ma7 = mkLine("#eab308");
    const ma25 = mkLine("#38bdf8");
    const ma99 = mkLine("#c084fc");
    const bollM = mkLine("#94a3b8");
    const bollU = mkLine("#64748b");
    const bollL = mkLine("#64748b");
    const macdH = chart.addSeries(HistogramSeries, { priceScaleId: "macd" }, 1);
    const macdL = mkLine("#60a5fa", 1);
    const sig = mkLine("#f0b90b", 1);
    chart.priceScale("macd").applyOptions({ scaleMargins: { top: 0.15, bottom: 0.1 } });
    api.current = { chart, candle, vol, ema20, ema50, ma7, ma25, ma99, bollM, bollU, bollL, macdH, macdL, sig };
    return () => { chart.remove(); api.current = null; };
  }, []);

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    let stop = false;
    let ws: WebSocket | null = null;
    let poll: number | undefined;
    (async () => {
      setStamp("chart", `正在补齐 ${symbol} ${tf} 真实 K 线…`);
      lastBars.current = [];
      try {
        const pack = await loadKlines(symbol, tf);
        if (stop) return;
        lastBars.current = pack.bars;
        source.current = pack.source;
        applyBars(a, pack.bars, pack.ready, inds, onLegend);
        a.chart.timeScale().fitContent();
        setStamp("chart", pack.note, !pack.bars.length);
      } catch {
        setStamp("chart", "K 线加载失败", true);
        return;
      }

      const isMark = source.current === "futures-mark";
      const isFut = source.current !== "spot";
      const applyLast = (bar: Candle) => {
        const bars = lastBars.current;
        const i = bars.findIndex((b) => b.time === bar.time);
        if (i >= 0) bars[i] = { ...bars[i], ...bar, volume: bar.volume || bars[i].volume };
        else if (!bars.length || bar.time > bars[bars.length - 1].time) bars.push(bar);
        lastBars.current = bars;
        const ready = source.current === "futures-mark" ? bars.length >= 50 : bars.length >= 200;
        if (api.current) applyBars(api.current, bars, ready, inds, onLegend);
      };

      if (isFut) {
        // fstream：成交价 K 线；标记价格图额外轮询最新标记 K 线 + 标记价
        const open = () => {
          if (stop) return;
          const stream = `${symbol.toLowerCase()}@kline_${tf}`;
          const url = FUT_WS[0].replace(/\/$/, "") + stream;
          // FUT_WS is already /stream?streams=
          const u = FUT_WS[0].includes("?streams=") ? FUT_WS[0] + stream : `wss://fstream.binance.com/ws/${stream}`;
          try { ws = new WebSocket(u); } catch { return; }
          ws.onmessage = (ev) => {
            try {
              const d = JSON.parse(ev.data) as { data?: { k?: KMsg }; k?: KMsg };
              const k = d.k || d.data?.k;
              if (!k || isMark) return; // 标记价格图不用成交价去改均线
              applyLast({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, quote: 0, buyQ: 0 });
            } catch { /* */ }
          };
        };
        if (!isMark) open();
        const loop = async () => {
          if (stop) return;
          if (isMark) {
            const [bar, mk] = await Promise.all([fetchLastFutKline(symbol, tf, true), fetchMarkPrice(symbol)]);
            if (bar) {
              if (mk?.mark) {
                bar.close = mk.mark;
                bar.high = Math.max(bar.high, mk.mark);
                bar.low = Math.min(bar.low, mk.mark);
              }
              applyLast(bar);
            }
          } else {
            const bar = await fetchLastFutKline(symbol, tf, false);
            if (bar) applyLast(bar);
          }
        };
        loop();
        poll = window.setInterval(loop, 8000);
      } else {
        const stream = `/${symbol.toLowerCase()}@kline_${tf}`;
        const open = (i = 0) => {
          if (stop) return;
          const url = SPOT_WS[i % SPOT_WS.length].replace(/\/$/, "") + stream;
          try { ws = new WebSocket(url); } catch { setTimeout(() => open(i + 1), 1500); return; }
          ws.onmessage = (ev) => {
            try {
              const d = JSON.parse(ev.data) as { k?: KMsg };
              const k = d.k;
              if (!k) return;
              applyLast({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, quote: 0, buyQ: 0 });
            } catch { /* */ }
          };
          ws.onclose = () => { if (!stop) setTimeout(() => open(i + 1), 2000); };
        };
        open();
      }
    })();
    return () => { stop = true; try { ws?.close(); } catch { /* */ } if (poll) clearInterval(poll); };
  }, [symbol, tf]);

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    applyBars(a, lastBars.current, lastBars.current.length >= 50, inds, onLegend);
  }, [inds]);

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    for (const l of priceLines.current) { try { a.candle.removePriceLine(l); } catch { /* */ } }
    priceLines.current = (lines || []).filter((l) => Number.isFinite(l.price) && l.price > 0).map((l) =>
      a.candle.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: LineStyle.Dashed, title: l.title, axisLabelVisible: true })
    );
  }, [lines]);

  return <div className="chart-box" ref={ref} />;
}

type KMsg = { t: number; o: string; h: string; l: string; c: string; v: string };
type ChartApi = {
  chart: IChartApi;
  candle: ISeriesApi<"Candlestick">;
  vol: ISeriesApi<"Histogram">;
  ema20: ISeriesApi<"Line">;
  ema50: ISeriesApi<"Line">;
  ma7: ISeriesApi<"Line">;
  ma25: ISeriesApi<"Line">;
  ma99: ISeriesApi<"Line">;
  bollM: ISeriesApi<"Line">;
  bollU: ISeriesApi<"Line">;
  bollL: ISeriesApi<"Line">;
  macdH: ISeriesApi<"Histogram">;
  macdL: ISeriesApi<"Line">;
  sig: ISeriesApi<"Line">;
};

function setLine(s: ISeriesApi<"Line">, bars: Candle[], arr: (number | undefined)[], on: boolean) {
  if (!on) { s.setData([]); return; }
  s.setData(bars.flatMap((b, i) => arr[i] != null ? [{ time: b.time as UTCTimestamp, value: arr[i] as number }] : []));
}

function lastTxt(arr: (number | undefined)[], d = 2) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return (arr[i] as number).toFixed(d);
  return "—";
}

function applyBars(a: ChartApi, bars: Candle[], ready: boolean, inds: IndOn, onLegend?: (s: string) => void) {
  if (!bars.length) return;
  a.candle.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
  a.vol.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? "rgba(14,203,129,0.45)" : "rgba(246,70,93,0.45)" })));
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  // 未就绪时绝不画部分均线，避免出现“估算值”
  if (!ready) {
    for (const s of [a.ema20, a.ema50, a.ma7, a.ma25, a.ma99, a.bollM, a.bollU, a.bollL, a.macdL, a.sig]) s.setData([]);
    a.macdH.setData([]);
    onLegend?.("历史不足，均线暂不显示");
    return;
  }
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  setLine(a.ema20, bars, e20, inds.ema20);
  setLine(a.ema50, bars, e50, inds.ema50);
  setLine(a.ma7, bars, ema(closes, 7), inds.ma);
  setLine(a.ma25, bars, ema(closes, 25), inds.ma);
  setLine(a.ma99, bars, ema(closes, 99), inds.ma);
  const b = boll(closes, 20, 2);
  setLine(a.bollM, bars, b.mid, inds.boll);
  setLine(a.bollU, bars, b.upper, inds.boll);
  setLine(a.bollL, bars, b.lower, inds.boll);
  const m = macd(closes);
  if (inds.macd) {
    a.macdL.setData(bars.flatMap((x, i) => m.macd[i] != null ? [{ time: x.time as UTCTimestamp, value: m.macd[i] as number }] : []));
    a.sig.setData(bars.flatMap((x, i) => m.signal[i] != null ? [{ time: x.time as UTCTimestamp, value: m.signal[i] as number }] : []));
    a.macdH.setData(bars.flatMap((x, i) => m.hist[i] != null ? [{
      time: x.time as UTCTimestamp, value: m.hist[i] as number,
      color: (m.hist[i] as number) >= 0 ? "rgba(14,203,129,0.7)" : "rgba(246,70,93,0.7)",
    }] : []));
  } else { a.macdL.setData([]); a.sig.setData([]); a.macdH.setData([]); }
  const a14 = atr(highs, lows, closes, 14);
  const bits = [
    inds.ema20 ? `EMA20 ${lastTxt(e20, 2)}` : "",
    inds.ema50 ? `EMA50 ${lastTxt(e50, 2)}` : "",
    inds.atr ? `ATR ${lastTxt(a14, 3)}` : "",
  ].filter(Boolean);
  onLegend?.(bits.join("  ·  "));
}
