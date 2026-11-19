import { useEffect, useRef } from "react";
import {
  createChart, CandlestickSeries, LineSeries, HistogramSeries,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from "lightweight-charts";
import { fetchKlines } from "../data/api";
import { SPOT_WS, setStamp } from "../data/store";
import { ema, macd, parseKlines, type Candle } from "../lib/indicators";

type Props = { symbol: string; tf: string; height?: number };

export default function ChartPane({ symbol, tf }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const api = useRef<{
    chart: IChartApi;
    candle: ISeriesApi<"Candlestick">;
    vol: ISeriesApi<"Histogram">;
    ma7: ISeriesApi<"Line">;
    ma25: ISeriesApi<"Line">;
    ma99: ISeriesApi<"Line">;
    macdH: ISeriesApi<"Histogram">;
    macdL: ISeriesApi<"Line">;
    sig: ISeriesApi<"Line">;
  } | null>(null);
  const lastBars = useRef<Candle[]>([]);

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
    const vol = chart.addSeries(HistogramSeries, {
      priceScaleId: "vol", priceFormat: { type: "volume" },
    }, 0);
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });
    const ma7 = chart.addSeries(LineSeries, { color: "#f0b90b", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0);
    const ma25 = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0);
    const ma99 = chart.addSeries(LineSeries, { color: "#c084fc", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0);
    const macdH = chart.addSeries(HistogramSeries, { priceScaleId: "macd" }, 1);
    const macdL = chart.addSeries(LineSeries, { color: "#60a5fa", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceScaleId: "macd" }, 1);
    const sig = chart.addSeries(LineSeries, { color: "#f0b90b", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceScaleId: "macd" }, 1);
    chart.priceScale("macd").applyOptions({ scaleMargins: { top: 0.15, bottom: 0.1 } });
    api.current = { chart, candle, vol, ma7, ma25, ma99, macdH, macdL, sig };
    return () => { chart.remove(); api.current = null; };
  }, []);

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    let stop = false;
    let ws: WebSocket | null = null;
    (async () => {
      setStamp("chart", `加载 ${symbol} ${tf}…`);
      try {
        const { base, rows } = await fetchKlines(symbol, tf, 400);
        if (stop) return;
        const bars = parseKlines(rows);
        lastBars.current = bars;
        applyBars(a, bars);
        a.chart.timeScale().fitContent();
        setStamp("chart", `${symbol} · ${tf} · ${base.replace("https://", "")}`);
      } catch {
        setStamp("chart", "K 线加载失败", true);
        return;
      }
      const stream = `/${symbol.toLowerCase()}@kline_${tf}`;
      const open = (i = 0) => {
        if (stop) return;
        const url = SPOT_WS[i % SPOT_WS.length].replace(/\/$/, "") + stream;
        try { ws = new WebSocket(url); } catch { setTimeout(() => open(i + 1), 1500); return; }
        let got = 0;
        const t = window.setTimeout(() => { if (!got) ws?.close(); }, 4000);
        ws.onmessage = (ev) => {
          got++;
          try {
            const d = JSON.parse(ev.data) as { k?: { t: number; o: string; h: string; l: string; c: string; v: string } };
            const k = d.k;
            if (!k || !api.current) return;
            const ts = Math.floor(k.t / 1000) as UTCTimestamp;
            const bar = { time: ts, open: +k.o, high: +k.h, low: +k.l, close: +k.c };
            api.current.candle.update(bar);
            api.current.vol.update({ time: ts, value: +k.v, color: bar.close >= bar.open ? "rgba(14,203,129,0.45)" : "rgba(246,70,93,0.45)" });
          } catch { /* */ }
        };
        ws.onclose = () => { clearTimeout(t); if (!stop) setTimeout(() => open(got ? i : i + 1), 2000); };
      };
      open();
    })();
    return () => { stop = true; try { ws?.close(); } catch { /* */ } };
  }, [symbol, tf]);

  return <div className="chart-box" ref={ref} />;
}

type Api = NonNullable<ReturnType<typeof useRef<unknown>>["current"]> & {
  candle: ISeriesApi<"Candlestick">;
  vol: ISeriesApi<"Histogram">;
  ma7: ISeriesApi<"Line">;
  ma25: ISeriesApi<"Line">;
  ma99: ISeriesApi<"Line">;
  macdH: ISeriesApi<"Histogram">;
  macdL: ISeriesApi<"Line">;
  sig: ISeriesApi<"Line">;
};
function applyBars(a: {
  candle: ISeriesApi<"Candlestick">;
  vol: ISeriesApi<"Histogram">;
  ma7: ISeriesApi<"Line">;
  ma25: ISeriesApi<"Line">;
  ma99: ISeriesApi<"Line">;
  macdH: ISeriesApi<"Histogram">;
  macdL: ISeriesApi<"Line">;
  sig: ISeriesApi<"Line">;
}, bars: Candle[]) {
  a.candle.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
  a.vol.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? "rgba(14,203,129,0.45)" : "rgba(246,70,93,0.45)" })));
  const closes = bars.map((b) => b.close);
  const setLine = (s: ISeriesApi<"Line">, arr: (number | undefined)[]) => {
    s.setData(bars.flatMap((b, i) => arr[i] != null ? [{ time: b.time as UTCTimestamp, value: arr[i] as number }] : []));
  };
  setLine(a.ma7, ema(closes, 7));
  setLine(a.ma25, ema(closes, 25));
  setLine(a.ma99, ema(closes, 99));
  const m = macd(closes);
  a.macdL.setData(bars.flatMap((b, i) => m.macd[i] != null ? [{ time: b.time as UTCTimestamp, value: m.macd[i] as number }] : []));
  a.sig.setData(bars.flatMap((b, i) => m.signal[i] != null ? [{ time: b.time as UTCTimestamp, value: m.signal[i] as number }] : []));
  a.macdH.setData(bars.flatMap((b, i) => m.hist[i] != null ? [{
    time: b.time as UTCTimestamp, value: m.hist[i] as number,
    color: (m.hist[i] as number) >= 0 ? "rgba(14,203,129,0.7)" : "rgba(246,70,93,0.7)",
  }] : []));
}
