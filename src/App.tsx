import { useEffect } from "react";
import { useStore } from "./lib/useStore";
import { fmtPrice, fmtPct, chgClass, fmtTime } from "./lib/format";
import { MAJORS } from "./data/store";
import { boot, setRoute } from "./data/boot";
import Market from "./pages/Market";
import ChartPage from "./pages/ChartPage";
import Deriv from "./pages/Deriv";
import Radar from "./pages/Radar";
import Mine from "./pages/Mine";
import WatchSide from "./components/WatchSide";
import BookTrades from "./components/BookTrades";

const TABS: { id: string; label: string }[] = [
  { id: "market", label: "看盘" },
  { id: "chart", label: "图表" },
  { id: "deriv", label: "衍生品" },
  { id: "radar", label: "雷达" },
  { id: "mine", label: "我的" },
];

export default function App() {
  const st = useStore();
  useEffect(() => { boot(); }, []);

  const body =
    st.tab === "chart" ? <ChartPage /> :
    st.tab === "deriv" ? <Deriv /> :
    st.tab === "radar" ? <Radar /> :
    st.tab === "mine" ? <Mine /> :
    <Market />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src={import.meta.env.BASE_URL + "icons/icon-192.png"} alt="" width={22} height={22} />
          <h1>交易观察台</h1>
        </div>
        <nav className="dnav">
          {TABS.map((t) => (
            <button key={t.id} className={st.tab === t.id ? "on" : ""} onClick={() => setRoute(t.id, st.symbol)}>{t.label}</button>
          ))}
        </nav>
        <div className="ticker-row">
          {MAJORS.slice(0, st.phone ? 4 : 6).map((s) => {
            const t = st.tickers[s];
            return (
              <div className="tick" key={s} onClick={() => setRoute("chart", s)} style={{ cursor: "pointer" }}>
                <span className="s">{s.replace("USDT", "")}</span>
                <span className="p">{fmtPrice(t?.c)}</span>
                <span className={"c " + chgClass(t?.chg)}>{fmtPct(t?.chg)}</span>
              </div>
            );
          })}
        </div>
        <div className="status-group">
          <span className={"st " + st.spot.state} title={st.spot.detail}>{st.spot.label}</span>
          <span className={"st " + st.fut.state} title={st.fut.detail}>{st.fut.label}</span>
          <span className="st wait">{fmtTime(Date.now(), false)}</span>
        </div>
      </header>

      <div className="workspace">
        <aside className="side"><WatchSide /></aside>
        <main className="main">{body}</main>
        <aside className="rail"><BookTrades tabs={false} /></aside>
      </div>

      <nav className="tabbar">
        {TABS.map((t) => (
          <button key={t.id} className={st.tab === t.id ? "on" : ""} onClick={() => setRoute(t.id, st.symbol)}>{t.label}</button>
        ))}
      </nav>

      <div className="toasts">
        {st.toasts.map((t) => <div className="toast" key={t.id}>{t.msg}</div>)}
      </div>
    </div>
  );
}

