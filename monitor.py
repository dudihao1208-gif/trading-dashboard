#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""交易观察台监控：GitHub Actions 轮询 或 --realtime WebSocket 常驻。

机会雷达会把放量、极端资金费、持仓量骤升、恐慌贪婪极端、代币溢价、
自选大波动推到 Telegram。所有提醒带冷却与去重。不是投资建议，不下单。
密钥只用环境变量 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID，不要写进仓库。
Worker 地址用环境变量 WORKER_URL 或 config 里的 worker_url（不是密钥）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import quote
from typing import Any, Dict, List, Optional, Tuple

try:
    import requests
except ImportError:
    print("请先安装依赖： pip install -r requirements.txt", file=sys.stderr)
    raise

ROOT = Path(__file__).resolve().parent
SPOT_REST = ["https://data-api.binance.vision", "https://api.binance.com"]
FAPI_REST = ["https://fapi.binance.com"]
OKX = "https://www.okx.com"
FF_CALENDAR = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=5d"
FNG_URL = "https://api.alternative.me/fng/?limit=1"
CG_XSTOCKS = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=xstocks-ecosystem&order=market_cap_desc&per_page=30&page=1"
TELEGRAM_API = "https://api.telegram.org/bot{token}/sendMessage"
DEFAULT_EQUITY = ["AAPL", "NVDA", "TSLA", "GOOGL", "AMZN", "MSFT", "META", "SPY", "QQQ", "MSTR", "COIN", "INTC", "AMD", "CRCL", "SNDK", "PLTR"]
XSPECIAL = {"SPCX": None, "STRCX": None, "CRCLX": "CRCL", "SNDKX": "SNDK", "SPYX": "SPY", "QQQX": "QQQ", "GOOGLX": "GOOGL"}

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "trading-dashboard-monitor/2.0", "Accept": "application/json"})

WORKER_URL = ""


def now_ts() -> float:
    return time.time()


def iso_utc(ts: Optional[float] = None) -> str:
    return datetime.fromtimestamp(ts or now_ts(), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fmt_local(ts: Optional[float] = None) -> str:
    try:
        return datetime.fromtimestamp(ts or now_ts()).astimezone().strftime("%Y-%m-%d %H:%M:%S (%Z)")
    except Exception:
        return iso_utc(ts)


def log(msg: str) -> None:
    print(f"[{fmt_local()}] {msg}", flush=True)


def load_json(path: Path, default: Any) -> Any:
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        log(f"读取 {path} 失败：{e}")
    return default


def save_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def resolve_worker_url(cfg: Optional[Dict[str, Any]] = None) -> str:
    raw = os.environ.get("WORKER_URL") or (cfg or {}).get("worker_url") or ""
    return str(raw).strip().rstrip("/")


def via_worker(url: str) -> Optional[str]:
    if not WORKER_URL:
        return None
    if url.startswith(WORKER_URL):
        return url
    if url.startswith("/"):
        return WORKER_URL + url
    return WORKER_URL + "/proxy?url=" + quote(url, safe="")


def _raw_get(url: str, timeout: int) -> Optional[Any]:
    try:
        r = SESSION.get(url, timeout=timeout)
        if r.status_code == 451:
            return {"__error": 451, "__url": url}
        r.raise_for_status()
        if "application/json" in r.headers.get("content-type", "") or (r.text[:1] in "[{"):
            return r.json()
        return r.text
    except Exception as e:
        log(f"GET 失败 {url.split('?')[0]} ：{type(e).__name__}")
        return None


def http_get(url: str, timeout: int = 15) -> Optional[Any]:
    data = _raw_get(url, timeout)
    need = data is None or (isinstance(data, dict) and data.get("__error") == 451)
    if need:
        proxied = via_worker(url)
        if proxied and proxied != url:
            log(f"改走 Worker 代理 {url.split('?')[0]}")
            data = _raw_get(proxied, timeout)
    return data


def spot_get(path: str) -> Optional[Any]:
    for base in SPOT_REST:
        data = http_get(base + path)
        if data is None:
            continue
        if isinstance(data, dict) and data.get("__error") == 451:
            log(f"现货 {base} 地区限制，换备用域名")
            continue
        return data
    return None


def fapi_get(path: str) -> Optional[Any]:
    data = http_get(FAPI_REST[0] + path)
    if isinstance(data, dict) and data.get("__error") == 451:
        log("期货 fapi 被地区限制")
        return None
    return data


def okx_get(path: str) -> Optional[Any]:
    data = http_get(OKX + path)
    if isinstance(data, dict) and data.get("code") == "0":
        return data.get("data")
    return None


def load_config(path: Path) -> Dict[str, Any]:
    cfg = load_json(path, {}) or {}
    cfg.setdefault("symbols", ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"])
    cfg.setdefault("price_alerts", [])
    cfg.setdefault("funding_abs_threshold", 0.001)
    cfg.setdefault("volume_spike_ratio", 4.0)
    cfg.setdefault("volume_interval", "5m")
    cfg.setdefault("volume_lookback", 24)
    cfg.setdefault("liquidation_alert_usd", 2_000_000)
    cfg.setdefault("cooldown_minutes", 180)
    cfg.setdefault("calendar_impact", ["High"])
    cfg.setdefault("dashboard_url", "https://dudihao1208-gif.github.io/trading-dashboard/")
    cfg.setdefault("radar", {})
    global WORKER_URL
    WORKER_URL = resolve_worker_url(cfg)
    if WORKER_URL:
        log(f"已启用 Worker 代理：{WORKER_URL}")
    return cfg


def telegram_creds(cfg: Dict[str, Any]) -> Tuple[str, str]:
    tg = cfg.get("telegram") or {}
    token = os.environ.get("TELEGRAM_BOT_TOKEN") or tg.get("bot_token") or ""
    chat = os.environ.get("TELEGRAM_CHAT_ID") or tg.get("chat_id") or ""
    return str(token).strip(), str(chat).strip()


def send_telegram(token: str, chat: str, text: str, dry_run: bool) -> bool:
    if dry_run or not token or not chat:
        log(("【演练，不发送】" if dry_run else "【未配置 Telegram，仅日志】") + "\n" + text)
        return False
    try:
        r = SESSION.post(
            TELEGRAM_API.format(token=token),
            json={"chat_id": chat, "text": text, "disable_web_page_preview": True},
            timeout=20,
        )
        if r.status_code >= 400:
            log(f"Telegram 发送失败 HTTP {r.status_code}")
            return False
        log("Telegram 已发送")
        return True
    except Exception as e:
        log(f"Telegram 发送异常：{type(e).__name__}")
        return False


def cooled(state: Dict[str, Any], key: str, minutes: float) -> bool:
    last = (state.get("alerts") or {}).get(key)
    if not last:
        return False
    try:
        return (now_ts() - float(last)) < minutes * 60
    except Exception:
        return False


def mark(state: Dict[str, Any], key: str) -> None:
    state.setdefault("alerts", {})[key] = now_ts()


def fmt_price(p: float) -> str:
    if p >= 1000:
        return f"{p:,.2f}"
    if p >= 1:
        return f"{p:.4f}".rstrip("0").rstrip(".")
    return f"{p:.8f}".rstrip("0").rstrip(".")


def chart_link(cfg: Dict[str, Any], symbol: str) -> str:
    base = str(cfg.get("dashboard_url") or "").rstrip("/") + "/"
    return f"{base}?tab=chart&symbol={symbol}"


def footer() -> str:
    return "\n——\n仅供观察，不构成投资建议，不会自动交易。"


def fetch_tickers(symbols: List[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    data = spot_get("/api/v3/ticker/24hr")
    if not isinstance(data, list):
        for s in symbols:
            one = spot_get(f"/api/v3/ticker/24hr?symbol={s}")
            if isinstance(one, dict) and "lastPrice" in one:
                out[s] = one
        return out
    want = set(symbols)
    for row in data:
        sym = row.get("symbol")
        if sym in want:
            out[sym] = row
    return out


def fetch_funding(symbols: List[str]) -> Dict[str, Dict[str, Any]]:
    result: Dict[str, Dict[str, Any]] = {}
    prem = fapi_get("/fapi/v1/premiumIndex")
    if isinstance(prem, list):
        for row in prem:
            sym = row.get("symbol")
            if sym in symbols:
                try:
                    result[sym] = {"rate": float(row.get("lastFundingRate") or 0), "source": "binance-fapi", "oi_usd": None}
                except (TypeError, ValueError):
                    pass
    for sym in symbols:
        if sym in result:
            continue
        inst = sym.replace("USDT", "-USDT-SWAP")
        data = okx_get(f"/api/v5/public/funding-rate?instId={inst}")
        if data:
            try:
                result[sym] = {"rate": float(data[0]["fundingRate"]), "source": "okx", "oi_usd": None}
            except Exception:
                pass
        time.sleep(0.08)
    oi_all = okx_get("/api/v5/public/open-interest?instType=SWAP")
    if isinstance(oi_all, list):
        by = {x.get("instId"): x for x in oi_all}
        for sym, row in result.items():
            inst = sym.replace("USDT", "-USDT-SWAP")
            if inst in by:
                try:
                    row["oi_usd"] = float(by[inst].get("oiUsd") or 0)
                except (TypeError, ValueError):
                    pass
    return result


def volume_spike(symbol: str, ratio: float, interval: str, lookback: int) -> Optional[Dict[str, Any]]:
    limit = max(lookback + 2, 10)
    data = spot_get(f"/api/v3/klines?symbol={symbol}&interval={interval}&limit={limit}")
    if not isinstance(data, list) or len(data) < lookback:
        return None
    closed = data[:-1] if len(data) > lookback else data
    vols = []
    for k in closed:
        try:
            vols.append(float(k[5]))
        except (TypeError, ValueError, IndexError):
            pass
    if len(vols) < 5:
        return None
    last, prev = vols[-1], sorted(vols[:-1])
    median = prev[len(prev) // 2]
    if median <= 0:
        return None
    r = last / median
    if r >= ratio:
        return {"symbol": symbol, "ratio": r, "interval": interval}
    return None


def underlying_of(xsym: str) -> Optional[str]:
    u = (xsym or "").upper()
    if u in XSPECIAL:
        return XSPECIAL[u]
    if u.endswith("X") and len(u) >= 3:
        return u[:-1]
    return None


def radar_messages(cfg: Dict[str, Any], state: Dict[str, Any], tickers, funding) -> List[str]:
    rd = cfg.get("radar") or {}
    cooldown = float(cfg.get("cooldown_minutes") or 180)
    msgs: List[str] = []
    symbols = [s.upper() for s in (cfg.get("symbols") or [])]

    # 价格突破（仅在用户明确配置了阈值时）
    for a in cfg.get("price_alerts") or []:
        sym = (a.get("symbol") or "").upper()
        if not sym or sym not in tickers:
            continue
        try:
            px = float(tickers[sym]["lastPrice"])
        except Exception:
            continue
        chg = tickers[sym].get("priceChangePercent")
        for edge, cmp, arrow, lab in (
            ("above", lambda p, th: p >= th, "⬆️", "突破上限"),
            ("below", lambda p, th: p <= th, "⬇️", "跌破下限"),
        ):
            th = a.get(edge)
            if th in (None, "", 0):
                continue
            if cmp(px, float(th)):
                key = f"{sym}:{edge}:{th}"
                if cooled(state, key, cooldown):
                    continue
                msgs.append(
                    f"{arrow} {lab} {sym}\n现价 {fmt_price(px)}（24h {chg}%），阈值 {fmt_price(float(th))}\n{chart_link(cfg, sym)}"
                )
                mark(state, key)

    # 资金费极端
    th_f = float(cfg.get("funding_abs_threshold") or 0.001)
    for sym, row in funding.items():
        rate = row.get("rate")
        if rate is None or abs(rate) < th_f:
            continue
        key = f"{sym}:funding:{'pos' if rate > 0 else 'neg'}"
        if cooled(state, key, cooldown):
            continue
        msgs.append(
            f"💸 资金费率异常 {sym}\n当前 {(rate * 100):.4f}%（来源 {row.get('source')}，阈值 ±{th_f * 100:.3f}%）\n{chart_link(cfg, sym)}"
        )
        mark(state, key)

    # 放量
    ratio = float(cfg.get("volume_spike_ratio") or 4.0)
    interval = str(cfg.get("volume_interval") or "5m")
    lookback = int(cfg.get("volume_lookback") or 24)
    for sym in symbols:
        spike = volume_spike(sym, ratio, interval, lookback)
        if not spike:
            continue
        key = f"{sym}:volspike"
        if cooled(state, key, cooldown):
            continue
        msgs.append(
            f"📊 放量异动 {sym}\n最近一根 {spike['interval']} K 线成交量约为中位数的 {spike['ratio']:.1f} 倍\n{chart_link(cfg, sym)}"
        )
        mark(state, key)
        time.sleep(0.05)

    # 持仓量骤升：与上次快照比较；第一次只记底，不告警
    oi_th = float(rd.get("oi_surge_pct") or 8)
    prev_oi = state.setdefault("oi_usd", {})
    for sym, row in funding.items():
        oi = row.get("oi_usd")
        if not oi:
            continue
        old = prev_oi.get(sym)
        prev_oi[sym] = oi
        if not old:
            continue
        chg = (oi / old - 1) * 100
        if abs(chg) < oi_th:
            continue
        key = f"{sym}:oi:{'up' if chg > 0 else 'dn'}"
        if cooled(state, key, cooldown):
            continue
        msgs.append(
            f"📦 持仓量骤变 {sym}\n相对上次观察 {chg:+.1f}%（阈值 ±{oi_th:.0f}%），约 ${oi:,.0f}\n{chart_link(cfg, sym)}"
        )
        mark(state, key)

    # 恐慌贪婪
    fng = http_get(FNG_URL)
    try:
        row = (fng or {}).get("data", [None])[0]
        val = int(row["value"])
        klass = row.get("value_classification") or ""
        lo, hi = int(rd.get("fng_extreme_low") or 15), int(rd.get("fng_extreme_high") or 85)
        hours = float(rd.get("fng_cooldown_hours") or 24)
        if val <= lo or val >= hi:
            key = f"fng:{'fear' if val <= lo else 'greed'}"
            if not cooled(state, key, hours * 60):
                msgs.append(
                    f"🌡 恐慌贪婪极端：{val}（{klass}）\n只反映市场情绪，不代表方向。\n{chart_link(cfg, 'BTCUSDT')}"
                )
                mark(state, key)
    except Exception:
        pass

    # 代币溢价
    prem_th = float(rd.get("stock_premium_pct") or 5)
    prem_cd = float(rd.get("premium_cooldown_hours") or 12) * 60
    eq_path = ROOT / "public-data" / "equities.json"
    eq = load_json(eq_path, {}) or {}
    quotes = eq.get("quotes") or {}
    xs = http_get(CG_XSTOCKS)
    if isinstance(xs, list):
        for c in xs:
            try:
                sym = str(c.get("symbol") or "").upper()
                tok = float(c.get("current_price"))
                u = underlying_of(sym)
                q = quotes.get(u) if u else None
                if not q or not q.get("price"):
                    continue
                prem = (tok / float(q["price"]) - 1) * 100
                if abs(prem) < prem_th:
                    continue
                key = f"prem:{sym}:{'hi' if prem > 0 else 'lo'}"
                if cooled(state, key, prem_cd):
                    continue
                msgs.append(
                    f"🏷️ 代币溢价 {sym}\n相对正股 {u} {prem:+.2f}%（代币 {tok:.2f} / 正股 {float(q['price']):.2f}）\n{chart_link(cfg, 'BTCUSDT')}"
                )
                mark(state, key)
            except Exception:
                continue

    # 自选 24h 大波动（仅配置的 symbols，冷却长）
    move_th = float(rd.get("watchlist_move_pct") or 8)
    for sym in symbols:
        if sym not in tickers:
            continue
        try:
            chg = float(tickers[sym].get("priceChangePercent") or 0)
        except (TypeError, ValueError):
            continue
        if abs(chg) < move_th:
            continue
        key = f"{sym}:d24"
        if cooled(state, key, 12 * 60):
            continue
        px = float(tickers[sym]["lastPrice"])
        msgs.append(
            f"⚡ 自选大波动 {sym}\n24h {chg:+.2f}%（阈值 ±{move_th:.0f}%），现价 {fmt_price(px)}\n{chart_link(cfg, sym)}"
        )
        mark(state, key)

    # 宏观（未来 8 小时高影响，单轮最多 2 条）
    impacts = set(cfg.get("calendar_impact") or ["High"])
    cal = http_get(FF_CALENDAR)
    if isinstance(cal, list):
        now = datetime.now(timezone.utc)
        horizon = now + timedelta(hours=8)
        n = 0
        for ev in cal:
            if n >= 2:
                break
            try:
                if (ev.get("impact") or "") not in impacts:
                    continue
                dt = datetime.fromisoformat(ev.get("date") or "")
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                if not (now - timedelta(minutes=20) <= dt <= horizon):
                    continue
                key = f"cal:{ev.get('country')}:{ev.get('title')}:{ev.get('date')}"
                if cooled(state, key, 360):
                    continue
                when = dt.astimezone().strftime("%m-%d %H:%M %Z")
                msgs.append(
                    f"📅 宏观即将公布：{ev.get('country') or ''} {ev.get('title')}（{ev.get('impact')}）\n时间 {when}  前值 {ev.get('previous') or '—'}  预测 {ev.get('forecast') or '—'}"
                )
                mark(state, key)
                n += 1
            except Exception:
                continue
    return msgs


def run_poll(cfg, state, dry_run: bool) -> int:
    symbols = [s.upper() for s in (cfg.get("symbols") or [])]
    token, chat = telegram_creds(cfg)
    log(f"轮询开始，关注 {', '.join(symbols)}")
    tickers = fetch_tickers(symbols)
    for s, t in tickers.items():
        log(f"  {s}  {t.get('lastPrice')}  24h {t.get('priceChangePercent')}%")
    funding = fetch_funding(symbols)
    for s, f in funding.items():
        log(f"  资金费 {s} {f.get('rate')} ({f.get('source')})")
    msgs = radar_messages(cfg, state, tickers, funding)
    if msgs:
        # 单轮最多 4 条，避免刷屏
        body = "📡 机会雷达\n" + fmt_local() + "\n\n" + "\n\n".join(msgs[:4]) + footer()
        send_telegram(token, chat, body, dry_run)
        if len(msgs) > 4:
            log(f"本轮另有 {len(msgs) - 4} 条因单轮上限未发出")
    else:
        log("本轮没有新的提醒（或仍在冷却中）")
    return 0


def write_public(cfg) -> int:
    cal_path = ROOT / "public-data" / "calendar.json"
    eq_path = ROOT / "public-data" / "equities.json"
    cal_path.parent.mkdir(parents=True, exist_ok=True)
    cal = http_get(FF_CALENDAR)
    events = cal if isinstance(cal, list) else []
    save_json(cal_path, {"generated_at": iso_utc(), "source": FF_CALENDAR, "events": events})
    log(f"已写入日历 {len(events)} 条")
    quotes: Dict[str, Any] = {}
    for sym in cfg.get("equity_tickers") or DEFAULT_EQUITY:
        data = http_get(YAHOO_CHART.format(symbol=sym), timeout=15)
        time.sleep(0.15)
        try:
            result = (data or {}).get("chart", {}).get("result") or []
            if not result:
                continue
            meta = result[0].get("meta") or {}
            ts = result[0].get("timestamp") or []
            q = ((result[0].get("indicators") or {}).get("quote") or [{}])[0]
            closes = q.get("close") or []
            last = meta.get("regularMarketPrice")
            prev = meta.get("chartPreviousClose") or meta.get("previousClose")
            valid = [c for c in closes if c is not None]
            change_pct = None
            if last is not None and prev:
                change_pct = (float(last) / float(prev) - 1.0) * 100.0
            elif len(valid) >= 2:
                change_pct = (valid[-1] / valid[-2] - 1.0) * 100.0
                last = last if last is not None else valid[-1]
            quotes[sym] = {
                "price": last,
                "change_percent": change_pct,
                "currency": meta.get("currency"),
                "name": meta.get("shortName") or meta.get("longName") or sym,
                "daily_closes": [
                    {"t": int(ts[i]), "c": closes[i]}
                    for i in range(min(len(ts), len(closes)))
                    if closes[i] is not None
                ][-30:],
            }
        except Exception as e:
            log(f"解析 {sym} 正股失败：{type(e).__name__}")
    save_json(eq_path, {"generated_at": iso_utc(), "source": "https://query1.finance.yahoo.com", "quotes": quotes})
    log(f"已写入正股 {len(quotes)} 只")
    return 0


def run_realtime(cfg, state, state_path: Path, dry_run: bool) -> int:
    try:
        import websocket
    except ImportError:
        log("实时模式需要 websocket-client： pip install -r requirements.txt")
        return 2

    symbols = set(s.upper() for s in (cfg.get("symbols") or []))
    cooldown = float(cfg.get("cooldown_minutes") or 180)
    token, chat = telegram_creds(cfg)
    prefer = bool(cfg.get("prefer_official_binance", True))
    liq_min = float(cfg.get("liquidation_alert_usd") or 2_000_000)
    last_poll = 0.0

    try:
        run_poll(cfg, state, dry_run)
        last_poll = now_ts()
        save_json(state_path, state)
    except Exception:
        log("启动轮询失败：\n" + traceback.format_exc())

    def emit(msgs: List[str]) -> None:
        if not msgs:
            return
        send_telegram(token, chat, "📡 机会雷达（实时）\n" + fmt_local() + "\n\n" + "\n\n".join(msgs[:4]) + footer(), dry_run)
        save_json(state_path, state)

    def on_spot(_ws, message: str) -> None:
        nonlocal last_poll
        try:
            data = json.loads(message)
        except Exception:
            return
        rows = data if isinstance(data, list) else [data]
        alerts = []
        price_cfgs = {(a.get("symbol") or "").upper(): a for a in (cfg.get("price_alerts") or [])}
        for row in rows:
            sym = row.get("s")
            if not sym:
                continue
            try:
                px = float(row.get("c") or 0)
            except (TypeError, ValueError):
                continue
            a = price_cfgs.get(sym)
            if not a:
                continue
            for edge, ok, arrow, lab in (
                ("above", px >= float(a["above"]) if a.get("above") not in (None, "", 0) else False, "⬆️", "突破上限"),
                ("below", px <= float(a["below"]) if a.get("below") not in (None, "", 0) else False, "⬇️", "跌破下限"),
            ):
                if not ok:
                    continue
                th = a.get(edge)
                key = f"{sym}:{edge}:{th}"
                if cooled(state, key, cooldown):
                    continue
                alerts.append(f"{arrow} {lab} {sym}\n现价 {fmt_price(px)}，阈值 {fmt_price(float(th))}\n{chart_link(cfg, sym)}")
                mark(state, key)
        if alerts:
            emit(alerts)
        if now_ts() - last_poll >= 180:
            last_poll = now_ts()
            try:
                tickers = fetch_tickers(list(symbols))
                funding = fetch_funding(list(symbols))
                extra = radar_messages(cfg, state, tickers, funding)
                if extra:
                    emit(extra)
            except Exception:
                log("周期补查失败：\n" + traceback.format_exc())

    def on_fut(_ws, message: str) -> None:
        try:
            payload = json.loads(message)
        except Exception:
            return
        data = payload.get("data") if isinstance(payload, dict) and "data" in payload else payload
        ev = data.get("e") if isinstance(data, dict) else None
        alerts = []
        if ev == "forceOrder":
            try:
                o = data.get("o") or {}
                sym = o.get("s")
                px = float(o.get("ap") or o.get("p") or 0)
                qty = float(o.get("q") or 0)
                usd = px * qty
                side = o.get("S")
                if usd >= liq_min and (sym in symbols or usd >= liq_min * 3):
                    key = f"{sym}:liq:{int(now_ts() // 60)}"
                    if not cooled(state, key, min(cooldown, 30)):
                        alerts.append(
                            f"💥 大额爆仓 {sym} {'空' if side == 'BUY' else '多'} 约 ${usd:,.0f} @ {fmt_price(px)}\n{chart_link(cfg, sym or 'BTCUSDT')}"
                        )
                        mark(state, key)
            except Exception:
                return
        if alerts:
            emit(alerts)

    def connect_loop(urls: List[str], handler, name: str) -> None:
        import threading

        def run() -> None:
            idx, backoff = 0, 1
            while True:
                url = urls[idx % len(urls)]
                log(f"{name} 连接 {url}")
                try:
                    ws = websocket.WebSocketApp(
                        url, on_message=handler,
                        on_error=lambda _w, e: log(f"{name} 错误：{e}"),
                        on_close=lambda *_a: log(f"{name} 断开"),
                        on_open=lambda _w: log(f"{name} 已连接"),
                    )
                    ws.run_forever(ping_interval=20, ping_timeout=10)
                except Exception as e:
                    log(f"{name} 异常：{e}")
                idx += 1
                log(f"{name} {backoff}s 后重连")
                time.sleep(backoff)
                backoff = min(backoff * 2, 30)

        threading.Thread(target=run, name=name, daemon=True).start()

    vision = "wss://data-stream.binance.vision/ws/!miniTicker@arr"
    official = ["wss://stream.binance.com:9443/ws/!miniTicker@arr", "wss://stream.binance.com:443/ws/!miniTicker@arr"]
    spot = (official + [vision]) if prefer else ([vision] + official)
    fut = ["wss://fstream.binance.com/stream?streams=!forceOrder@arr/btcusdt@markPrice@1s"]
    connect_loop(spot, on_spot, "现货WS")
    connect_loop(fut, on_fut, "期货WS")
    log("实时模式已启动（Ctrl+C 退出）")
    try:
        while True:
            time.sleep(5)
    except KeyboardInterrupt:
        log("收到中断，退出")
        save_json(state_path, state)
        return 0


def test_ping(cfg, dry_run: bool) -> int:
    token, chat = telegram_creds(cfg)
    text = (
        "【测试】交易观察台机会雷达已上线。\n"
        "这是唯一一条连通性测试，不是交易信号。\n"
        + chart_link(cfg, "BTCUSDT")
        + footer()
    )
    send_telegram(token, chat, text, dry_run)
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="交易观察台监控")
    p.add_argument("--config", default=str(ROOT / "config.json"))
    p.add_argument("--state", default=str(ROOT / ".monitor-state.json"))
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--realtime", action="store_true")
    p.add_argument("--write-public", action="store_true")
    p.add_argument("--test-ping", action="store_true", help="只发一条标明测试的连通消息")
    args = p.parse_args(argv)
    cfg = load_config(Path(args.config))
    state_path = Path(args.state)
    state = load_json(state_path, {"alerts": {}})
    if not isinstance(state, dict):
        state = {"alerts": {}}
    try:
        if args.test_ping:
            return test_ping(cfg, args.dry_run)
        if args.write_public:
            return write_public(cfg)
        if args.realtime:
            return run_realtime(cfg, state, state_path, args.dry_run)
        rc = run_poll(cfg, state, args.dry_run)
        save_json(state_path, state)
        return rc
    except Exception:
        log("未处理异常：\n" + traceback.format_exc())
        try:
            save_json(state_path, state)
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
