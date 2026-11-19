/* 交易观察台 — 浏览器端独立运行 */
(function () {
  "use strict";

  const MAJORS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
  const HEAT_SYMS = MAJORS.concat(["ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "LTCUSDT", "ATOMUSDT"]);
  const LS_CCY = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"];
  const SPOT_REST = ["https://api.binance.com", "https://data-api.binance.vision"];
  const FAPI_REST = ["https://fapi.binance.com"];
  const SPOT_WS = [
    "wss://data-stream.binance.vision/ws",
    "wss://stream.binance.com:9443/ws",
    "wss://stream.binance.com:443/ws"
  ];
  const FUT_WS = ["wss://fstream.binance.com/stream?streams="];
  const OKX = "https://www.okx.com";
  const FNG = "https://api.alternative.me/fng/?limit=1";
  const CG_GLOBAL = "https://api.coingecko.com/api/v3/global";
  const CG_XSTOCKS = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=xstocks-ecosystem&order=market_cap_desc&per_page=30&page=1&sparkline=false&price_change_percentage=24h";
  const HN = "https://hn.algolia.com/api/v1/search?query=bitcoin%20OR%20ethereum%20OR%20crypto%20OR%20binance&tags=story&hitsPerPage=20";
  const LS_KEY = "trading-obs-v1";
  const LEV_RE = /(UP|DOWN|BULL|BEAR|3L|3S|5L|5S)USDT$/;
  const MIN_QUOTE_VOL = 1_000_000;

  const XSTOCK_SPECIAL = { SPCX: null, STRCX: null, CRCLX: "CRCL", SNDKX: "SNDK", SPYX: "SPY", QQQX: "QQQ", GOOGLX: "GOOGL" };

  const state = {
    tickers: {},          // symbol -> {c,o,h,l,v,q,chg,src,t}
    allSymbols: [],
    funding: {},          // symbol -> {rate, source, t}
    oi: {},
    liqs: [],
    watch: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    alerts: {},           // symbol -> {above, below}
    alertLog: [],
    fired: {},
    tab: "overview",
    chart: { symbol: "BTCUSDT", tf: "1h", obj: null, series: null, vol: null, loading: false },
    calImpact: "all",
    calendar: [],
    calendarMeta: "",
    equities: {},
    equitiesMeta: "",
    xstocks: [],
    restSpotBase: null,
    spotWs: { status: "off", url: "", last: 0 },
    futWs: { status: "off", url: "", last: 0, frames: 0 }
  };

  /* ---------- utils ---------- */
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

  function loadLS() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (Array.isArray(d.watch) && d.watch.length) state.watch = d.watch;
      if (d.alerts && typeof d.alerts === "object") state.alerts = d.alerts;
      if (Array.isArray(d.alertLog)) state.alertLog = d.alertLog.slice(0, 50);
    } catch (e) { /* ignore */ }
  }
  function saveLS() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        watch: state.watch, alerts: state.alerts, alertLog: state.alertLog.slice(0, 50)
      }));
    } catch (e) { /* quota */ }
  }

  function fmtNum(n, d) {
    if (n == null || !isFinite(n)) return "—";
    return Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
  }
  function fmtPrice(n) {
    if (n == null || !isFinite(n)) return "—";
    const x = Number(n);
    if (x >= 1000) return fmtNum(x, 2);
    if (x >= 1) return String(+x.toFixed(4));
    if (x >= 0.01) return String(+x.toFixed(5));
    return String(+x.toFixed(8));
  }
  function fmtPct(n, signed) {
    if (n == null || !isFinite(n)) return "—";
    const s = (signed && n > 0 ? "+" : "") + Number(n).toFixed(2) + "%";
    return s;
  }
  function fmtUsd(n) {
    if (n == null || !isFinite(n)) return "—";
    const x = Number(n);
    const abs = Math.abs(x);
    if (abs >= 1e12) return (x / 1e12).toFixed(2) + "T";
    if (abs >= 1e9) return (x / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return (x / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return (x / 1e3).toFixed(1) + "K";
    return x.toFixed(0);
  }
  function fmtTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    return d.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function fmtDateTime(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function chgClass(n) { return n > 0 ? "up" : n < 0 ? "down" : ""; }
  function stamp(name, text, err) {
    $$('[data-stamp="' + name + '"]').forEach((el) => {
      el.textContent = text;
      el.classList.toggle("err", !!err);
    });
  }
  function toast(msg, warn) {
    const box = $("#toasts");
    const el = document.createElement("div");
    el.className = "toast" + (warn ? " warn" : "");
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
  function setPill(id, st, title) {
    const el = $("#" + id);
    if (!el) return;
    el.dataset.state = st;
    if (title) el.title = title;
    const labels = {
      "pill-spot": { live: "现货实时", rest: "现货REST", on: "现货连接中", off: "现货断开", err: "现货失败" },
      "pill-fut": { live: "期货实时", rest: "期货备用", on: "期货连接中", off: "期货不可用", err: "期货不可用" }
    };
    const map = labels[id];
    if (map) {
      const dot = el.querySelector("i");
      el.textContent = "";
      if (dot) el.appendChild(dot);
      else {
        const i = document.createElement("i");
        el.appendChild(i);
      }
      el.appendChild(document.createTextNode(map[st] || map.off));
    }
  }

  async function getJSON(url, timeout) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout || 12000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) {
        const err = new Error("HTTP " + res.status);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function firstOK(urls, mapUrl, timeout) {
    let last;
    for (const base of urls) {
      const url = typeof mapUrl === "function" ? mapUrl(base) : base + mapUrl;
      try {
        const data = await getJSON(url, timeout || 8000);
        return { base, data, url };
      } catch (e) {
        last = e;
        if (e && e.status === 451) continue;
      }
    }
    throw last || new Error("全部失败");
  }

  /* ---------- persistence of live tickers ---------- */
  function upsertTicker(sym, rec) {
    const prev = state.tickers[sym] || {};
    const next = Object.assign({}, prev, rec, { t: rec.t || Date.now() });
    if (next.c != null && next.o) next.chg = ((next.c / next.o) - 1) * 100;
    state.tickers[sym] = next;
    checkAlerts(sym, next);
    return next;
  }

  function checkAlerts(sym, t) {
    const a = state.alerts[sym];
    if (!a || t.c == null) return;
    const px = t.c;
    const fire = (key, msg) => {
      const cooldown = 5 * 60 * 1000;
      if (state.fired[key] && Date.now() - state.fired[key] < cooldown) return;
      state.fired[key] = Date.now();
      pushAlert(msg);
    };
    if (a.above != null && a.above !== "" && px >= Number(a.above)) {
      fire(sym + ":above:" + a.above, "⬆️ " + sym + " 现价 " + fmtPrice(px) + " 突破 " + fmtPrice(Number(a.above)));
    }
    if (a.below != null && a.below !== "" && px <= Number(a.below)) {
      fire(sym + ":below:" + a.below, "⬇️ " + sym + " 现价 " + fmtPrice(px) + " 跌破 " + fmtPrice(Number(a.below)));
    }
  }

  function pushAlert(msg) {
    state.alertLog.unshift({ t: Date.now(), msg: msg });
    state.alertLog = state.alertLog.slice(0, 50);
    saveLS();
    renderAlertLog();
    toast(msg);
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("交易观察台", { body: msg, icon: "icons/icon-192.png", tag: msg.slice(0, 40) });
      }
    } catch (e) { /* iOS quirks */ }
    try { if (navigator.vibrate) navigator.vibrate(80); } catch (e) { /* */ }
  }

  /* ---------- WebSocket ---------- */
  function wsConnect(urls, pathOrQuery, onMsg, bucket, name, opts) {
    let idx = 0, sock = null, watchdog = null, dead = false;
    const noDataMs = (opts && opts.noDataMs) || 15000;
    const openGrace = (opts && opts.openGrace) || 4000;

    function setStatus(st, extra) {
      bucket.status = st;
      bucket.url = extra || bucket.url;
      if (name === "spot") setPill("pill-spot", st === "live" ? "live" : st === "on" ? "on" : st === "rest" ? "rest" : "err", bucket.url);
      if (name === "fut") setPill("pill-fut", st === "live" ? "live" : st === "on" ? "on" : "err", bucket.url || "期货推送");
    }

    function armWatch() {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (dead) return;
        // 连上却长时间无数据（美国 IP 上 fstream 常见）
        if (!bucket.last || Date.now() - bucket.last > noDataMs) {
          try { sock && sock.close(); } catch (e) { /* */ }
        }
      }, noDataMs);
    }

    function connect() {
      if (dead) return;
      const base = urls[idx % urls.length];
      const url = base.endsWith("=") || base.includes("?") ? base + pathOrQuery : base + pathOrQuery;
      bucket.url = url;
      setStatus("on", url);
      try { sock = new WebSocket(url); } catch (e) {
        idx += 1;
        setTimeout(connect, 1500);
        return;
      }
      const openedAt = Date.now();
      sock.onopen = () => { setStatus("on", url); armWatch(); };
      sock.onmessage = (ev) => {
        bucket.last = Date.now();
        bucket.frames = (bucket.frames || 0) + 1;
        setStatus("live", url);
        armWatch();
        try { onMsg(JSON.parse(ev.data)); } catch (e) { /* */ }
      };
      sock.onerror = () => {};
      sock.onclose = () => {
        if (dead) return;
        setStatus("off");
        const quickFail = Date.now() - openedAt < openGrace && !bucket.frames;
        if (quickFail) idx += 1;
        else if (bucket.last && Date.now() - (bucket.last || 0) >= noDataMs - 100) idx += 1;
        const wait = Math.min(1000 * Math.pow(1.6, idx % 8), 12000);
        setTimeout(connect, wait);
      };
    }
    connect();
    return {
      stop() { dead = true; clearTimeout(watchdog); try { sock && sock.close(); } catch (e) { /* */ } },
      reopen() { try { sock && sock.close(); } catch (e) { /* */ } }
    };
  }

  function startSockets() {
    wsConnect(SPOT_WS, "/!miniTicker@arr", (data) => {
      const rows = Array.isArray(data) ? data : (data.data || [data]);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r.s) continue;
        upsertTicker(r.s, {
          c: +r.c, o: +r.o, h: +r.h, l: +r.l, v: +r.v, q: +r.q, src: "ws"
        });
      }
      if (state.tab === "overview") renderMajors();
      if (state.tab === "overview") renderMovers();
      if (state.tab === "watch") renderWatch();
      updateSummaryBtc();
    }, state.spotWs, "spot", { noDataMs: 20000 });

    const futStreams = ["!forceOrder@arr"]
      .concat(MAJORS.map((s) => s.toLowerCase() + "@markPrice@1s"))
      .join("/");
    wsConnect(FUT_WS, futStreams, (payload) => {
      const stream = payload && payload.stream;
      const d = (payload && payload.data) || payload;
      if (!d) return;
      if (d.e === "forceOrder" || (d.o && d.e === "forceOrder")) {
        const o = d.o || {};
        const px = +(o.ap || o.p || 0);
        const qty = +(o.q || 0);
        const rec = {
          t: d.E || Date.now(),
          s: o.s,
          side: o.S === "BUY" ? "空" : "多",
          px: px,
          usd: px * qty
        };
        state.liqs.unshift(rec);
        state.liqs = state.liqs.slice(0, 80);
        if (state.tab === "deriv") renderLiqs();
        if (rec.usd >= 1_000_000) pushAlert("💥 爆仓 " + rec.s + " " + rec.side + " 约 $" + fmtUsd(rec.usd));
      } else if (d.e === "markPriceUpdate" || d.r != null) {
        const sym = d.s;
        if (sym && d.r != null) {
          state.funding[sym] = { rate: +d.r, source: "币安期货WS", t: Date.now(), mark: +d.p };
          if (state.tab === "overview") renderFundingMini();
          if (state.tab === "deriv") renderHeat();
        }
      }
    }, state.futWs, "fut", { noDataMs: 12000, openGrace: 5000 });
  }

  /* ---------- REST fallbacks ---------- */
  async function refreshSpotRest() {
    try {
      const r = await firstOK(SPOT_REST, "/api/v3/ticker/24hr", 15000);
      state.restSpotBase = r.base;
      const list = Array.isArray(r.data) ? r.data : [];
      const syms = [];
      for (let i = 0; i < list.length; i++) {
        const row = list[i];
        const s = row.symbol;
        if (!s) continue;
        syms.push(s);
        if (s.endsWith("USDT")) {
          upsertTicker(s, {
            c: +row.lastPrice, o: +row.openPrice, h: +row.highPrice, l: +row.lowPrice,
            v: +row.volume, q: +row.quoteVolume,
            chg: +row.priceChangePercent, src: "rest"
          });
        }
      }
      state.allSymbols = syms.filter((s) => s.endsWith("USDT") && !LEV_RE.test(s)).sort();
      fillDatalist();
      renderMajors();
      renderMovers();
      renderWatch();
      updateSummaryBtc();
      if (state.spotWs.status !== "live") setPill("pill-spot", "rest", r.base);
      stamp("majors", "REST " + fmtTime(Date.now()) + " · " + r.base.replace("https://", ""));
    } catch (e) {
      stamp("majors", "行情拉取失败", true);
    }
  }

  async function refreshFundingRest() {
    // 先尝试币安全市场资金费，失败再用 OKX
    let got = 0;
    try {
      const r = await firstOK(FAPI_REST, "/fapi/v1/premiumIndex", 7000);
      if (Array.isArray(r.data)) {
        r.data.forEach((row) => {
          if (!row.symbol) return;
          state.funding[row.symbol] = { rate: +row.lastFundingRate, source: "币安期货", t: Date.now(), mark: +row.markPrice };
          got++;
        });
      }
    } catch (e) { /* 451 expected in US */ }
    const need = HEAT_SYMS.filter((s) => !state.funding[s]);
    await mapPool(need, 4, async (sym) => {
      const inst = instOf(sym);
      try {
        const data = await getJSON(OKX + "/api/v5/public/funding-rate?instId=" + inst, 8000);
        if (data && data.code === "0" && data.data && data.data[0]) {
          state.funding[sym] = { rate: +data.data[0].fundingRate, source: "OKX", t: Date.now() };
          got++;
        }
      } catch (e) { /* */ }
    });
    try {
      const oi = await getJSON(OKX + "/api/v5/public/open-interest?instType=SWAP", 10000);
      if (oi && oi.code === "0" && Array.isArray(oi.data)) {
        oi.data.forEach((x) => { state.oi[x.instId] = x; });
      }
    } catch (e) { /* */ }
    const src = (state.funding.BTCUSDT && state.funding.BTCUSDT.source) || "—";
    stamp("funding", got ? (src + " · " + fmtTime(Date.now())) : "资金费暂不可用", !got);
    stamp("heat", got ? (src + " · " + fmtTime(Date.now())) : "资金费暂不可用", !got);
    renderFundingMini();
    renderHeat();
  }

  function instOf(sym) {
    if (sym.endsWith("USDT")) return sym.slice(0, -4) + "-USDT-SWAP";
    return sym + "-SWAP";
  }

  async function mapPool(items, limit, fn) {
    let i = 0;
    async function worker() {
      while (i < items.length) {
        const cur = items[i++];
        await fn(cur);
      }
    }
    const n = Math.min(limit, items.length) || 0;
    const ws = [];
    for (let k = 0; k < n; k++) ws.push(worker());
    await Promise.all(ws);
  }

  async function refreshMacro() {
    try {
      const g = await getJSON(CG_GLOBAL, 10000);
      const d = g && g.data;
      if (d) {
        setChip("mcap", "$" + fmtUsd(d.total_market_cap && d.total_market_cap.usd));
        setChip("dom", (d.market_cap_percentage && d.market_cap_percentage.btc != null)
          ? Number(d.market_cap_percentage.btc).toFixed(1) + "%" : "—");
        setChip("vol", "$" + fmtUsd(d.total_volume && d.total_volume.usd));
      }
    } catch (e) {
      setChip("mcap", "失败", true);
    }
    try {
      const f = await getJSON(FNG, 8000);
      const row = f && f.data && f.data[0];
      if (row) {
        const v = +row.value;
        const el = setChip("fng", v + " · " + (row.value_classification || ""), false);
        if (el) {
          const span = el.querySelector(".v");
          if (span) {
            span.classList.remove("up", "down");
            span.classList.add(v >= 55 ? "up" : v <= 45 ? "down" : "");
          }
        }
      }
    } catch (e) {
      setChip("fng", "失败", true);
    }
  }

  function setChip(k, text, err) {
    const el = $('.chip[data-k="' + k + '"]');
    if (!el) return el;
    const v = el.querySelector(".v");
    v.textContent = text;
    v.classList.toggle("muted", !text || text === "—" || err);
    return el;
  }
  function updateSummaryBtc() {
    const t = state.tickers.BTCUSDT;
    if (!t || t.c == null) return;
    const el = setChip("btc", fmtPrice(t.c) + "  " + fmtPct(t.chg, true));
    const v = el && el.querySelector(".v");
    if (v) { v.classList.remove("up", "down", "muted"); v.classList.add(chgClass(t.chg)); }
  }

  /* ---------- renderers ---------- */
  function renderMajors() {
    const box = $("#major-grid");
    if (!box) return;
    if (!MAJORS.some((s) => state.tickers[s])) {
      box.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div>';
      return;
    }
    box.innerHTML = MAJORS.map((s) => {
      const t = state.tickers[s] || {};
      return '<div class="major" data-open="' + s + '"><div class="sym">' +
        s.replace("USDT", "") + '<span class="muted"> /USDT</span></div>' +
        '<div class="px">' + fmtPrice(t.c) + "</div>" +
        '<div class="meta"><span class="chg ' + chgClass(t.chg) + '">' + fmtPct(t.chg, true) +
        "</span><span>额 " + fmtUsd(t.q) + "</span></div></div>";
    }).join("");
    if (state.spotWs.status === "live") stamp("majors", "实时 · " + fmtTime(state.spotWs.last));
  }

  function usdtUniverse() {
    return Object.keys(state.tickers).filter((s) => s.endsWith("USDT") && !LEV_RE.test(s) && (state.tickers[s].q || 0) >= MIN_QUOTE_VOL);
  }

  function renderMovers() {
    const uni = usdtUniverse().map((s) => {
      const t = state.tickers[s];
      return { s: s, chg: t.chg, q: t.q, c: t.c };
    });
    if (!uni.length) return;
    const gain = uni.slice().sort((a, b) => (b.chg || -999) - (a.chg || -999)).slice(0, 12);
    const lose = uni.slice().sort((a, b) => (a.chg || 999) - (b.chg || 999)).slice(0, 12);
    fillMover("#tbl-gainers", gain);
    fillMover("#tbl-losers", lose);
    stamp("movers", "实时筛选 · 成交额≥$1M");
    stamp("movers2", "实时筛选 · 成交额≥$1M");
  }
  function fillMover(sel, rows) {
    const tb = $(sel + " tbody");
    if (!tb) return;
    tb.innerHTML = rows.map((r) =>
      "<tr data-open=\"" + r.s + "\"><td>" + r.s + "</td><td class=\"r " + chgClass(r.chg) + "\">" +
      fmtPct(r.chg, true) + "</td><td class=\"r\">" + fmtUsd(r.q) + "</td></tr>"
    ).join("");
  }

  function renderFundingMini() {
    const box = $("#funding-mini");
    if (!box) return;
    const cells = MAJORS.map((s) => {
      const f = state.funding[s];
      const rate = f ? f.rate * 100 : null;
      const cls = rate == null ? "" : rate > 0 ? "up" : rate < 0 ? "down" : "";
      const oi = state.oi[instOf(s)];
      const oiTxt = oi && oi.oiUsd ? "<div class='s'>OI " + fmtUsd(+oi.oiUsd) + "</div>" : "";
      return '<div class="fund-cell"><div class="s">' + s.replace("USDT", "") +
        "</div><div class=\"r " + cls + "\">" + (rate == null ? "—" : rate.toFixed(4) + "%") +
        "</div>" + oiTxt + "</div>";
    }).join("");
    box.innerHTML = cells;
  }

  function renderHeat() {
    const box = $("#funding-heat");
    if (!box) return;
    const rates = HEAT_SYMS.map((s) => state.funding[s] && state.funding[s].rate).filter((x) => x != null);
    const max = Math.max.apply(null, rates.map(Math.abs).concat([0.0003]));
    box.innerHTML = HEAT_SYMS.map((s) => {
      const f = state.funding[s];
      const rate = f ? f.rate : null;
      let bg = "var(--card-2)", fg = "var(--text)";
      if (rate != null) {
        const a = Math.min(Math.abs(rate) / max, 1);
        if (rate >= 0) { bg = "rgba(14,203,129," + (0.15 + a * 0.55) + ")"; fg = "#d1fae5"; }
        else { bg = "rgba(246,70,93," + (0.15 + a * 0.55) + ")"; fg = "#fee2e2"; }
      }
      return '<div class="heat-cell" style="background:' + bg + ';color:' + fg + '"><div class="s">' +
        s.replace("USDT", "") + "</div><div class=\"r\">" +
        (rate == null ? "—" : (rate * 100).toFixed(4) + "%") + "</div></div>";
    }).join("");
  }

  function renderLiqs() {
    const hint = $("#liq-hint");
    if (state.futWs.status === "live" && state.liqs.length) {
      hint.textContent = "来自币安期货强制平仓推送 · " + fmtTime(state.futWs.last);
      stamp("liq", "实时 · " + fmtTime(state.futWs.last));
    } else if (state.futWs.status === "live" && !state.liqs.length) {
      hint.textContent = "期货推送已连通，暂无新的爆仓事件。";
      stamp("liq", "已连接，等待事件");
    } else if (state.futWs.frames > 0) {
      hint.textContent = "期货推送已断开，正在重连。";
    } else {
      hint.textContent = "当前网络下币安期货 WebSocket 可能不可用（例如美国 IP 会握手成功但不推数据）。欧洲 / 亚洲节点通常正常。资金费与持仓量已改走 OKX 等备用接口。";
      stamp("liq", "期货推送不可用", true);
    }
    const tb = $("#tbl-liq tbody");
    if (!tb) return;
    if (!state.liqs.length) {
      tb.innerHTML = '<tr><td colspan="5" class="empty">暂无爆仓记录</td></tr>';
      return;
    }
    tb.innerHTML = state.liqs.slice(0, 40).map((r) =>
      "<tr><td>" + fmtTime(r.t) + "</td><td>" + r.s + "</td><td class=\"" +
      (r.side === "多" ? "down" : "up") + "\">" + r.side + "</td><td class=\"r\">" +
      fmtPrice(r.px) + "</td><td class=\"r\">$" + fmtUsd(r.usd) + "</td></tr>"
    ).join("");
  }

  /* ---------- charts ---------- */
  function ensureChart() {
    const el = $("#chart-el");
    if (!el || typeof LightweightCharts === "undefined") return null;
    if (state.chart.obj) return state.chart.obj;
    const chart = LightweightCharts.createChart(el, {
      layout: { background: { color: "#0e1318" }, textColor: "#848e9c" },
      grid: { vertLines: { color: "#1b222c" }, horzLines: { color: "#1b222c" } },
      rightPriceScale: { borderColor: "#2b3139" },
      timeScale: { borderColor: "#2b3139", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      autoSize: true
    });
    const series = chart.addCandlestickSeries({
      upColor: "#0ecb81", downColor: "#f6465d",
      borderUpColor: "#0ecb81", borderDownColor: "#f6465d",
      wickUpColor: "#0ecb81", wickDownColor: "#f6465d"
    });
    const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" } });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    state.chart.obj = chart;
    state.chart.series = series;
    state.chart.vol = vol;
    window.addEventListener("resize", () => chart.timeScale().fitContent());
    return chart;
  }

  let klineWs = null;
  async function loadKlines() {
    const sym = (state.chart.symbol || "BTCUSDT").toUpperCase();
    const tf = state.chart.tf || "1h";
    state.chart.symbol = sym;
    stamp("chart", "加载 " + sym + " " + tf + "…");
    ensureChart();
    if (!state.chart.series) {
      stamp("chart", "图表库未能加载（需联网访问 CDN）", true);
      return;
    }
    try {
      const r = await firstOK(SPOT_REST, "/api/v3/klines?symbol=" + encodeURIComponent(sym) + "&interval=" + tf + "&limit=400", 15000);
      const rows = r.data || [];
      const candles = [], volumes = [];
      let buyQ = 0, allQ = 0;
      rows.forEach((k) => {
        const t = Math.floor(k[0] / 1000);
        const o = +k[1], h = +k[2], l = +k[3], c = +k[4], v = +k[5], q = +k[7], tq = +k[10];
        candles.push({ time: t, open: o, high: h, low: l, close: c });
        volumes.push({ time: t, value: v, color: c >= o ? "rgba(14,203,129,0.5)" : "rgba(246,70,93,0.5)" });
        buyQ += tq; allQ += q;
      });
      state.chart.series.setData(candles);
      state.chart.vol.setData(volumes);
      state.chart.obj.timeScale().fitContent();
      const ratio = allQ ? buyQ / allQ : 0.5;
      const track = $("#taker-track .buy");
      if (track) track.style.width = (ratio * 100).toFixed(1) + "%";
      $("#taker-nums").innerHTML = '<span class="up">主动买 ' + (ratio * 100).toFixed(1) +
        "%</span>  /  <span class=\"down\">主动卖 " + ((1 - ratio) * 100).toFixed(1) + "%</span>（币安 K 线 taker buy）";
      stamp("chart", sym + " · " + tf + " · " + r.base.replace("https://", "") + " · " + fmtTime(Date.now()));
      subscribeKline(sym, tf);
    } catch (e) {
      stamp("chart", "K 线加载失败", true);
      $("#taker-nums").textContent = "K 线加载失败";
    }
  }

  function subscribeKline(sym, tf) {
    try { if (klineWs) klineWs.close(); } catch (e) { /* */ }
    const stream = "/" + sym.toLowerCase() + "@kline_" + tf;
    const bases = SPOT_WS;
    let i = 0;
    const open = () => {
      const url = bases[i % bases.length] + stream;
      try { klineWs = new WebSocket(url); } catch (e) { i++; setTimeout(open, 1500); return; }
      klineWs.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          const k = d.k || (d.data && d.data.k);
          if (!k || !state.chart.series) return;
          const t = Math.floor(k.t / 1000);
          const o = +k.o, h = +k.h, l = +k.l, c = +k.c, v = +k.v;
          state.chart.series.update({ time: t, open: o, high: h, low: l, close: c });
          state.chart.vol.update({ time: t, value: v, color: c >= o ? "rgba(14,203,129,0.5)" : "rgba(246,70,93,0.5)" });
        } catch (e) { /* */ }
      };
      klineWs.onclose = () => { /* 切周期时会关，不自动猛烈重连 */ };
    };
    open();
  }

  let oiChart = null, oiSeries = null;
  async function loadOI() {
    const ccy = ($("#oi-symbol") && $("#oi-symbol").value) || "BTC";
    const inst = ccy + "-USDT-SWAP";
    const el = $("#oi-chart");
    if (typeof LightweightCharts === "undefined") {
      stamp("oi", "图表库未加载", true);
      return;
    }
    try {
      const data = await getJSON(OKX + "/api/v5/rubik/stat/contracts/open-interest-history?instId=" + inst + "&period=1H", 12000);
      if (!data || data.code !== "0" || !data.data || !data.data.length) throw new Error("无数据");
      const points = data.data.map((x) => ({ time: Math.floor((+x[0]) / 1000), value: +x[3] || +x[1] })).filter((p) => p.time && isFinite(p.value)).sort((a, b) => a.time - b.time);
      if (!oiChart) {
        oiChart = LightweightCharts.createChart(el, {
          layout: { background: { color: "#0e1318" }, textColor: "#848e9c" },
          grid: { vertLines: { color: "#1b222c" }, horzLines: { color: "#1b222c" } },
          rightPriceScale: { borderColor: "#2b3139" },
          timeScale: { borderColor: "#2b3139", timeVisible: true },
          autoSize: true
        });
        oiSeries = oiChart.addAreaSeries({
          lineColor: "#f0b90b", topColor: "rgba(240,185,11,0.28)", bottomColor: "rgba(240,185,11,0.02)"
        });
      }
      oiSeries.setData(points);
      oiChart.timeScale().fitContent();
      const last = points[points.length - 1];
      const first = points[0];
      const chg = first && last ? ((last.value / first.value) - 1) * 100 : null;
      $("#oi-hint").textContent = ccy + " 永续持仓量（USD）来自 OKX 近 " + points.length + " 小时" +
        (chg != null ? "，区间变化 " + fmtPct(chg, true) : "");
      stamp("oi", "OKX · " + fmtTime(Date.now()));
    } catch (e) {
      stamp("oi", "持仓量趋势暂不可用", true);
      $("#oi-hint").textContent = "无法获取 OKX 持仓量历史。";
    }
  }

  async function loadLSAndTaker() {
    const lsBox = $("#ls-list");
    const tkBox = $("#taker-list");
    lsBox.innerHTML = "<div class='hint'>加载多空比…</div>";
    tkBox.innerHTML = "<div class='hint'>加载主动买卖…</div>";
    const lsRows = [], tkRows = [];
    await mapPool(LS_CCY, 3, async (ccy) => {
      try {
        const d = await getJSON(OKX + "/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=" + ccy + "&period=1H", 8000);
        if (d && d.code === "0" && d.data && d.data[0]) {
          const last = d.data[0]; // API 最新在前
          lsRows.push({ ccy: ccy, ratio: +last[1], t: +last[0] });
        }
      } catch (e) { /* */ }
      try {
        const d = await getJSON(OKX + "/api/v5/rubik/stat/taker-volume?ccy=" + ccy + "&period=1H&instType=CONTRACTS", 8000);
        if (d && d.code === "0" && d.data && d.data[0]) {
          const last = d.data[0];
          const sell = +last[1], buy = +last[2];
          const sum = buy + sell;
          tkRows.push({ ccy: ccy, buy: buy, sell: sell, ratio: sum ? buy / sum : 0.5 });
        }
      } catch (e) { /* */ }
    });
    if (!lsRows.length) {
      lsBox.innerHTML = "<p class='empty'>多空比暂不可用</p>";
      stamp("ls", "加载失败", true);
    } else {
      lsBox.innerHTML = lsRows.map((r) => {
        const longPct = r.ratio / (r.ratio + 1) * 100;
        return '<div class="ratio-item"><div class="row"><strong>' + r.ccy +
          "</strong><span>多/空 " + r.ratio.toFixed(2) + "（多 " + longPct.toFixed(1) + "%）</span></div>" +
          '<div class="bar"><span style="width:' + longPct.toFixed(1) + '%"></span></div></div>';
      }).join("");
      stamp("ls", "OKX · " + fmtTime(Date.now()));
    }
    if (!tkRows.length) {
      tkBox.innerHTML = "<p class='empty'>主动买卖暂不可用</p>";
      stamp("taker", "加载失败", true);
    } else {
      tkBox.innerHTML = tkRows.map((r) =>
        '<div class="ratio-item"><div class="row"><strong>' + r.ccy +
        "</strong><span><span class='up'>买 " + (r.ratio * 100).toFixed(1) +
        "%</span> / <span class='down'>卖 " + ((1 - r.ratio) * 100).toFixed(1) +
        "%</span></span></div><div class=\"bar\"><span style=\"width:" + (r.ratio * 100).toFixed(1) +
        '%"></span></div></div>'
      ).join("");
      stamp("taker", "OKX 合约主动成交 · " + fmtTime(Date.now()));
    }
  }

  /* ---------- scanner ---------- */
  async function runScanner() {
    stamp("scan", "扫描中…");
    const uni = usdtUniverse().sort((a, b) => (state.tickers[b].q || 0) - (state.tickers[a].q || 0)).slice(0, 25);
    if (!uni.length) {
      $("#tbl-scan tbody").innerHTML = '<tr><td colspan="5" class="empty">请等待行情加载</td></tr>';
      return;
    }
    const hits = [];
    await mapPool(uni, 5, async (sym) => {
      try {
        const r = await firstOK(SPOT_REST, "/api/v3/klines?symbol=" + sym + "&interval=5m&limit=30", 8000);
        const rows = r.data || [];
        const closed = rows.length > 2 ? rows.slice(0, -1) : rows;
        const vols = closed.map((k) => +k[5]).filter((x) => isFinite(x));
        if (vols.length < 8) return;
        const last = vols[vols.length - 1];
        const prev = vols.slice(0, -1).slice().sort((a, b) => a - b);
        const median = prev[Math.floor(prev.length / 2)];
        if (median > 0) {
          const ratio = last / median;
          if (ratio >= 2) {
            const t = state.tickers[sym] || {};
            hits.push({ s: sym, c: t.c, chg: t.chg, ratio: ratio, last: last });
          }
        }
      } catch (e) { /* skip */ }
    });
    hits.sort((a, b) => b.ratio - a.ratio);
    const tb = $("#tbl-scan tbody");
    if (!hits.length) {
      tb.innerHTML = '<tr><td colspan="5" class="empty">在成交额前 25 的 USDT 对中，暂无 5 分钟成交量 ≥ 2 倍中位数的标的</td></tr>';
    } else {
      tb.innerHTML = hits.map((r) =>
        "<tr data-open=\"" + r.s + "\"><td>" + r.s + "</td><td class=\"r\">" + fmtPrice(r.c) +
        "</td><td class=\"r " + chgClass(r.chg) + "\">" + fmtPct(r.chg, true) +
        "</td><td class=\"r up\">" + r.ratio.toFixed(1) + "x</td><td class=\"r\">" + fmtUsd(r.last) + "</td></tr>"
      ).join("");
    }
    stamp("scan", "完成 · " + fmtTime(Date.now()) + " · 检出 " + hits.length + " 个");
  }

  /* ---------- stocks ---------- */
  function underlyingOf(xsym) {
    const u = (xsym || "").toUpperCase();
    if (u in XSTOCK_SPECIAL) return XSTOCK_SPECIAL[u];
    if (u.endsWith("X") && u.length >= 3) return u.slice(0, -1);
    return null;
  }

  function pearson(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 5) return null;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, m = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i], y = b[i];
      if (!isFinite(x) || !isFinite(y)) continue;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; m++;
    }
    if (m < 5) return null;
    const cov = sxy - (sx * sy) / m;
    const vx = sxx - (sx * sx) / m;
    const vy = syy - (sy * sy) / m;
    const den = Math.sqrt(vx * vy);
    if (!den) return null;
    return cov / den;
  }

  function dailyReturns(closes) {
    const out = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i - 1] && closes[i]) out.push(closes[i] / closes[i - 1] - 1);
    }
    return out;
  }

  async function loadStocks() {
    stamp("stocks", "加载中…");
    try {
      const eq = await getJSON("public-data/equities.json", 8000);
      state.equities = (eq && eq.quotes) || {};
      state.equitiesMeta = eq && eq.generated_at ? ("正股 " + new Date(eq.generated_at).toLocaleString("zh-CN")) : "";
    } catch (e) {
      state.equities = {};
      state.equitiesMeta = "正股对比文件尚未生成";
    }
    try {
      state.xstocks = await getJSON(CG_XSTOCKS, 12000);
      if (!Array.isArray(state.xstocks)) throw new Error("格式");
      stamp("stocks", "CoinGecko · " + fmtTime(Date.now()) + (state.equitiesMeta ? " · " + state.equitiesMeta : ""));
    } catch (e) {
      state.xstocks = [];
      stamp("stocks", "CoinGecko 代币列表失败", true);
    }
    const hint = $("#stocks-hint");
    const nEq = Object.keys(state.equities).length;
    hint.textContent = nEq
      ? ("已载入 " + nEq + " 只正股报价，用于计算溢价与相关。正股更新时间取决于 GitHub Actions。")
      : "尚未读到 public-data/equities.json。把本仓库放到 GitHub 并让 Actions 跑起来后，会自动写入正股报价。现在只显示代币价格。";
    renderStocks();
    // 对前几只拉 30 日代币走势，算相关（注意 CoinGecko 限速）
    const top = (state.xstocks || []).slice(0, 8);
    await mapPool(top, 2, async (coin) => {
      const u = underlyingOf(coin.symbol);
      const eq = u && state.equities[u];
      if (!eq || !eq.daily_closes || eq.daily_closes.length < 6) return;
      try {
        const ch = await getJSON("https://api.coingecko.com/api/v3/coins/" + coin.id + "/market_chart?vs_currency=usd&days=30&interval=daily", 10000);
        const prices = (ch && ch.prices) || [];
        const tokenCloses = prices.map((p) => p[1]);
        const eqCloses = eq.daily_closes.map((p) => p.c);
        // 用收益率序列，截齐
        const rt = dailyReturns(tokenCloses);
        const re = dailyReturns(eqCloses);
        const n = Math.min(rt.length, re.length);
        coin._corr = pearson(rt.slice(-n), re.slice(-n));
      } catch (e) { /* rate limit */ }
    });
    renderStocks();
  }

  function renderStocks() {
    const tb = $("#tbl-stocks tbody");
    if (!tb) return;
    if (!state.xstocks.length) {
      tb.innerHTML = '<tr><td colspan="6" class="empty">代币列表暂不可用</td></tr>';
      return;
    }
    tb.innerHTML = state.xstocks.map((c) => {
      const u = underlyingOf(c.symbol);
      const eq = u && state.equities[u];
      const tok = c.current_price;
      const chg = c.price_change_percentage_24h;
      let prem = "—", eqp = "—", corr = c._corr != null ? c._corr.toFixed(2) : "—";
      if (eq && eq.price && tok) {
        eqp = "$" + fmtPrice(eq.price) + " <span class='" + chgClass(eq.change_percent) + "'>" + fmtPct(eq.change_percent, true) + "</span>";
        prem = (((tok / eq.price) - 1) * 100).toFixed(2) + "%";
      } else if (u === null) {
        eqp = "无公开正股";
      } else if (u) {
        eqp = u + " 待刷新";
      }
      return "<tr><td>" + (c.symbol || "").toUpperCase() + "<div class='muted' style='font-size:0.7rem'>" +
        (c.name || "") + "</div></td><td class='r'>$" + fmtPrice(tok) +
        "</td><td class='r " + chgClass(chg) + "'>" + fmtPct(chg, true) +
        "</td><td class='r'>" + eqp + "</td><td class='r'>" + prem +
        "</td><td class='r'>" + corr + "</td></tr>";
    }).join("");
  }

  /* ---------- watch ---------- */
  function fillDatalist() {
    const dl = $("#symbol-list");
    if (!dl) return;
    const list = (state.allSymbols.length ? state.allSymbols : MAJORS).slice(0, 800);
    dl.innerHTML = list.map((s) => "<option value=\"" + s + "\">").join("");
  }
  function normalizeSym(s) {
    s = (s || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!s) return "";
    if (!s.endsWith("USDT") && !s.endsWith("USDC") && !s.endsWith("BUSD")) s += "USDT";
    return s;
  }
  function renderWatch() {
    const tb = $("#tbl-watch tbody");
    if (!tb) return;
    if (!state.watch.length) {
      tb.innerHTML = '<tr><td colspan="6" class="empty">还没有自选，先添加一个交易对</td></tr>';
      return;
    }
    tb.innerHTML = state.watch.map((s) => {
      const t = state.tickers[s] || {};
      const a = state.alerts[s] || {};
      return "<tr data-open=\"" + s + "\"><td>" + s + "</td><td class='r'>" + fmtPrice(t.c) +
        "</td><td class='r " + chgClass(t.chg) + "'>" + fmtPct(t.chg, true) +
        "</td><td class='r'><input class='th' data-sym='" + s + "' data-k='above' type='number' step='any' placeholder='上限' value='" +
        (a.above != null ? a.above : "") + "'></td>" +
        "<td class='r'><input class='th' data-sym='" + s + "' data-k='below' type='number' step='any' placeholder='下限' value='" +
        (a.below != null ? a.below : "") + "'></td>" +
        "<td><button class='btn danger' data-del='" + s + "' type='button'>删除</button></td></tr>";
    }).join("");
    stamp("watch", "已存本机 · " + state.watch.length + " 个");
  }
  function renderAlertLog() {
    const ul = $("#alert-log");
    if (!ul) return;
    if (!state.alertLog.length) { ul.innerHTML = "<li class='empty'>暂无提醒</li>"; return; }
    ul.innerHTML = state.alertLog.map((a) => "<li>" + fmtDateTime(a.t) + "　" + a.msg + "</li>").join("");
  }

  /* ---------- news + calendar ---------- */
  async function loadCalendar() {
    try {
      const data = await getJSON("public-data/calendar.json", 8000);
      state.calendar = data.events || [];
      state.calendarMeta = data.generated_at
        ? ("更新于 " + new Date(data.generated_at).toLocaleString("zh-CN"))
        : "尚未生成，等待 GitHub Actions";
      stamp("cal", state.calendarMeta, !data.generated_at);
      $("#cal-hint").textContent = data.generated_at
        ? "数据来自 Forex Factory 公开周历，由仓库的 GitHub Actions 写入本站（源站本身不允许浏览器跨域）。时间按你手机的本地时区显示。"
        : "还没有日历数据。把本项目放到 GitHub 并开启 Actions 后，会自动写入 public-data/calendar.json。也可直接查看 Forex Factory 日历。";
    } catch (e) {
      state.calendar = [];
      stamp("cal", "日历文件不可用", true);
      $("#cal-hint").textContent = "无法读取 public-data/calendar.json。若你是直接打开本地文件，请改用 GitHub Pages 等方式托管；或等待 Actions 首次运行。";
    }
    renderCalendar();
  }
  function renderCalendar() {
    const tb = $("#tbl-cal tbody");
    let rows = state.calendar || [];
    if (state.calImpact !== "all") rows = rows.filter((e) => e.impact === state.calImpact);
    // 只显示今天起一周
    const now = Date.now() - 2 * 3600 * 1000;
    rows = rows.filter((e) => {
      const t = Date.parse(e.date);
      return isFinite(t) && t >= now;
    }).slice(0, 80);
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="6" class="empty">暂无事件</td></tr>';
      return;
    }
    tb.innerHTML = rows.map((e) => {
      const imp = e.impact || "";
      const cls = imp === "High" ? "down" : imp === "Medium" ? "" : "muted";
      const label = imp === "High" ? "高" : imp === "Medium" ? "中" : imp === "Low" ? "低" : imp;
      return "<tr><td>" + fmtDateTime(Date.parse(e.date)) + "</td><td>" + (e.country || "") +
        "</td><td>" + (e.title || "") + "</td><td class='" + cls + "'>" + label +
        "</td><td class='r'>" + (e.previous || "—") + "</td><td class='r'>" + (e.forecast || "—") + "</td></tr>";
    }).join("");
  }

  async function loadNews() {
    try {
      const d = await getJSON(HN, 10000);
      const hits = (d && d.hits) || [];
      const ul = $("#news-list");
      if (!hits.length) { ul.innerHTML = "<li class='empty'>暂无条目</li>"; stamp("news", "空", true); return; }
      ul.innerHTML = hits.map((h) => {
        const url = h.url || ("https://news.ycombinator.com/item?id=" + h.objectID);
        const when = h.created_at ? fmtDateTime(Date.parse(h.created_at)) : "";
        return "<li><a href=\"" + url + "\" target=\"_blank\" rel=\"noopener\">" + (h.title || "(无标题)") +
          "</a><div class='news-meta'>" + (h.author || "") + " · " + when + " · HN " + (h.points || 0) + " 分</div></li>";
      }).join("");
      stamp("news", "Hacker News · " + fmtTime(Date.now()));
    } catch (e) {
      $("#news-list").innerHTML = "<li class='empty'>资讯加载失败</li>";
      stamp("news", "加载失败", true);
    }
  }

  /* ---------- tabs / events ---------- */
  function showTab(name) {
    state.tab = name;
    $$(".panel").forEach((p) => p.classList.toggle("active", p.dataset.tab === name));
    $$("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    if (name === "chart") { ensureChart(); if (!state.chart.loaded) { state.chart.loaded = true; loadKlines(); } else if (state.chart.obj) state.chart.obj.timeScale().fitContent(); }
    if (name === "deriv") { renderHeat(); renderLiqs(); loadOI(); loadLSAndTaker(); }
    if (name === "scan") runScanner();
    if (name === "stocks") { if (!state.xstocks.length) loadStocks(); else renderStocks(); }
    if (name === "watch") { renderWatch(); renderAlertLog(); }
    if (name === "news") { if (!state.calendar.length) loadCalendar(); else renderCalendar(); if (!$("#news-list").dataset.loaded) { loadNews(); $("#news-list").dataset.loaded = "1"; } }
  }

  function bind() {
    $$("#tabbar button").forEach((b) => on(b, "click", () => showTab(b.dataset.tab)));
    on($("#tf-group"), "click", (e) => {
      const btn = e.target.closest("button[data-tf]");
      if (!btn) return;
      $$("#tf-group button").forEach((x) => x.classList.toggle("on", x === btn));
      state.chart.tf = btn.dataset.tf;
      loadKlines();
    });
    on($("#chart-symbol"), "change", () => {
      state.chart.symbol = normalizeSym($("#chart-symbol").value);
      $("#chart-symbol").value = state.chart.symbol;
      loadKlines();
    });
    on(document, "click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        const s = del.dataset.del;
        state.watch = state.watch.filter((x) => x !== s);
        delete state.alerts[s];
        saveLS();
        renderWatch();
        return;
      }
      const open = e.target.closest("[data-open]");
      if (open && !e.target.closest("input,button")) {
        state.chart.symbol = open.dataset.open;
        $("#chart-symbol").value = state.chart.symbol;
        showTab("chart");
        state.chart.loaded = true;
        loadKlines();
      }
    });
    on($("#watch-form"), "submit", (e) => {
      e.preventDefault();
      const s = normalizeSym($("#watch-input").value);
      if (!s) return;
      if (!state.watch.includes(s)) state.watch.push(s);
      state.alerts[s] = state.alerts[s] || {};
      $("#watch-input").value = "";
      saveLS();
      renderWatch();
    });
    on($("#tbl-watch"), "change", (e) => {
      const inp = e.target.closest("input.th");
      if (!inp) return;
      const s = inp.dataset.sym, k = inp.dataset.k;
      state.alerts[s] = state.alerts[s] || {};
      const v = inp.value === "" ? null : Number(inp.value);
      state.alerts[s][k] = (v != null && isFinite(v)) ? v : null;
      saveLS();
    });
    on($("#btn-notify"), "click", requestNotify);
    on($("#oi-symbol"), "change", loadOI);
    on($("#cal-filters"), "click", (e) => {
      const btn = e.target.closest("button[data-impact]");
      if (!btn) return;
      $$("#cal-filters button").forEach((x) => x.classList.toggle("on", x === btn));
      state.calImpact = btn.dataset.impact;
      renderCalendar();
    });
  }

  function requestNotify() {
    const hint = $("#notify-hint");
    if (!("Notification" in window)) {
      hint.textContent = "当前浏览器不支持通知 API。请用 Telegram 监控（GitHub Actions 或云主机）做后台提醒。";
      return;
    }
    const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
    const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isiOS && !standalone) {
      hint.textContent = "iPhone 请先用 Safari 打开本站，点分享 → 添加到主屏幕，再从图标进入后点这个按钮。需要 iOS 16.4 或更新版本。即使开启后，也只有观察台在前台（或刚打开）时会弹通知；后台请用 Telegram。";
      toast("请先把观察台添加到主屏幕", true);
    }
    Notification.requestPermission().then((p) => {
      if (p === "granted") {
        hint.textContent = "通知已开启。页面打开时价格触及阈值会立即提醒。锁屏后台仍请依赖 Telegram 监控。";
        try { new Notification("交易观察台", { body: "通知已开启。", icon: "icons/icon-192.png" }); } catch (e) { /* */ }
        toast("通知已开启");
      } else {
        hint.textContent = "未获得通知权限。可在系统设置中允许，或改用 Telegram。";
      }
    }).catch(() => {
      hint.textContent = "申请通知失败。iPhone 必须用主屏幕上的 PWA，且为 iOS 16.4+。";
    });
  }

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol === "file:") return;
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  /* ---------- boot ---------- */
  async function boot() {
    loadLS();
    bind();
    renderMajors();
    renderWatch();
    renderAlertLog();
    registerSW();
    startSockets();
    await refreshSpotRest();
    refreshMacro();
    refreshFundingRest();
    // 后台周期
    setInterval(() => {
      if (state.spotWs.status !== "live" || Date.now() - (state.spotWs.last || 0) > 20000) refreshSpotRest();
    }, 20000);
    setInterval(refreshMacro, 120000);
    setInterval(refreshFundingRest, 90000);
    setInterval(() => { if (state.tab === "scan") runScanner(); }, 180000);
    setInterval(() => {
      if (state.futWs.status !== "live") renderLiqs();
    }, 15000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
