import { useEffect, useState } from "react";
import { useStore } from "../lib/useStore";
import { fmtPrice, fmtQty, fmtTime } from "../lib/format";

function bookLabel(bookAt: number, bookLive: boolean, bookSrc: string, now: number) {
  if (!bookAt) return "盘口未连接";
  const stale = now - bookAt > 4000 || !bookLive;
  const src = bookSrc || (bookLive ? "实时" : "REST");
  return `${src} · ${fmtTime(bookAt)}${stale ? " · 已过期" : ""}`;
}

export default function BookTrades({ tabs = true }: { tabs?: boolean }) {
  const st = useStore();
  const [sub, setSub] = useState<"book" | "tape">("book");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const n = tabs ? 7 : 12;
  const asks = st.book.asks.slice(0, n).slice().reverse();
  const bids = st.book.bids.slice(0, n);
  const maxQ = Math.max(1, ...asks.map((x) => x.q), ...bids.map((x) => x.q));
  const mid = bids[0] && asks[asks.length - 1] ? (bids[0].p + asks[asks.length - 1].p) / 2 : bids[0]?.p;
  const stamp = bookLabel(st.bookAt, st.bookLive, st.bookSrc, now);
  const stale = !st.bookAt || now - st.bookAt > 4000 || !st.bookLive;
  const body = (
    <>
      {(!tabs || sub === "book") && (
        <div className="book">
          <div className="book-row muted"><span>卖价</span><span className="r">数量</span><span className="r">合计</span></div>
          {asks.map((x, i) => (
            <div className="book-row book-bar ask" key={"a" + i}>
              <i style={{ width: (x.q / maxQ) * 100 + "%" }} />
              <span className="down">{fmtPrice(x.p)}</span>
              <span className="r">{fmtQty(x.q)}</span>
              <span className="r muted">{fmtQty(x.p * x.q)}</span>
            </div>
          ))}
          <div style={{ padding: "6px 0", fontWeight: 800, fontSize: 14 }} className="num">{fmtPrice(mid)}</div>
          {bids.map((x, i) => (
            <div className="book-row book-bar bid" key={"b" + i}>
              <i style={{ width: (x.q / maxQ) * 100 + "%" }} />
              <span className="up">{fmtPrice(x.p)}</span>
              <span className="r">{fmtQty(x.q)}</span>
              <span className="r muted">{fmtQty(x.p * x.q)}</span>
            </div>
          ))}
          {!bids.length && !asks.length && <div className="empty">盘口加载中或暂不可用</div>}
        </div>
      )}
      {(!tabs || sub === "tape") && (
        <div className="tape">
          {st.trades.slice(0, 40).map((t, i) => (
            <div className="tape-row" key={t.t + "-" + i}>
              <span className="muted">{fmtTime(t.t)}</span>
              <span className={t.m ? "down" : "up"}>{fmtPrice(t.p)}</span>
              <span className="r">{fmtQty(t.q)}</span>
            </div>
          ))}
          {!st.trades.length && <div className="empty">等待成交推送</div>}
        </div>
      )}
    </>
  );
  if (!tabs) {
    return (
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
        <div className="card-h" style={{ padding: "8px 10px 0" }}>
          <h2>盘口</h2>
          <span className={"stamp" + (stale ? " err" : "")}>{stamp}</span>
        </div>
        <div className="book" style={{ flex: "1 1 55%" }}>
          {asks.map((x, i) => (
            <div className="book-row book-bar ask" key={"a" + i}>
              <i style={{ width: (x.q / maxQ) * 100 + "%" }} />
              <span className="down">{fmtPrice(x.p)}</span>
              <span className="r">{fmtQty(x.q)}</span>
              <span className="r muted">{fmtQty(x.p * x.q)}</span>
            </div>
          ))}
          <div style={{ padding: "6px 0", fontWeight: 800, fontSize: 14 }} className="num">{fmtPrice(mid)}</div>
          {bids.map((x, i) => (
            <div className="book-row book-bar bid" key={"b" + i}>
              <i style={{ width: (x.q / maxQ) * 100 + "%" }} />
              <span className="up">{fmtPrice(x.p)}</span>
              <span className="r">{fmtQty(x.q)}</span>
              <span className="r muted">{fmtQty(x.p * x.q)}</span>
            </div>
          ))}
        </div>
        <div className="card-h" style={{ padding: "8px 10px 0", borderTop: "1px solid var(--line)" }}>
          <h2>最新成交</h2>
          <span className={"stamp" + (!st.tradesAt || now - st.tradesAt > 8000 ? " err" : "")}>
            {st.tradesAt ? fmtTime(st.tradesAt) : "等待推送"}
          </span>
        </div>
        <div className="tape" style={{ flex: "1 1 45%" }}>
          {st.trades.slice(0, 30).map((t, i) => (
            <div className="tape-row" key={t.t + "-" + i}>
              <span className="muted">{fmtTime(t.t, false)}</span>
              <span className={t.m ? "down" : "up"}>{fmtPrice(t.p)}</span>
              <span className="r">{fmtQty(t.q)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 220, height: "40%" }}>
      <div className="subtabs">
        <button className={sub === "book" ? "on" : ""} onClick={() => setSub("book")}>盘口</button>
        <button className={sub === "tape" ? "on" : ""} onClick={() => setSub("tape")}>成交</button>
        <span className={"stamp" + (stale ? " err" : "")} style={{ marginLeft: "auto", padding: "6px 8px" }}>{stamp}</span>
      </div>
      {body}
    </div>
  );
}
