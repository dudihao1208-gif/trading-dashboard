#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""独立交易观察台监控脚本。

两种模式：
  1) 默认轮询（适合 GitHub Actions，约每 5–10 分钟一次，可能延迟）
  2) --realtime  WebSocket 常驻（适合非美国区域的 VPS / 电脑）

密钥不要写进仓库：使用环境变量 TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID，
或 config.json 里留空的 telegram 字段仅作本地填写（不要提交）。
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
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlencode

try:
    import requests
except ImportError:
    print("请先安装依赖： pip install -r requirements.txt", file=sys.stderr)
    raise

ROOT = Path(__file__).resolve().parent
ROME = timezone(timedelta(hours=1))  # Europe/Rome 冬令时；夏令时为 +2，仅用于日志展示时会再标 UTC

SPOT_REST = [
    "https://data-api.binance.vision",
    "https://api.binance.com",
]
FAPI_REST = [
    "https://fapi.binance.com",
]
OKX = "https://www.okx.com"
FF_CALENDAR = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=5d"
TELEGRAM_API = "https://api.telegram.org/bot{token}/sendMessage"

DEFAULT_EQUITY_TICKERS = [
    "AAPL", "NVDA", "TSLA", "GOOGL", "AMZN", "MSFT", "META", "SPY", "QQQ",
    "MSTR", "COIN", "INTC", "AMD", "NFLX", "CRCL", "SNDK", "PLTR", "BABA",
]

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "trading-dashboard-monitor/1.0",
    "Accept": "application/json",
})


def now_ts() -> float:
    return time.time()


def iso_utc(ts: Optional[float] = None) -> str:
    return datetime.fromtimestamp(ts or now_ts(), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fmt_rome(ts: Optional[float] = None) -> str:
    # 仅作可读展示：用本地时区（VPS 若设了 Europe/Rome 则自动正确；否则标 UTC）
    try:
        local = datetime.now().astimezone()
        label = local.tzname() or "local"
        return datetime.fromtimestamp(ts or now_ts()).astimezone().strftime(f"%Y-%m-%d %H:%M:%S ({label})")
    except Exception:
        return iso_utc(ts)


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


def log(msg: str) -> None:
    print(f"[{fmt_rome()}] {msg}", flush=True)


def http_get(url: str, timeout: int = 15) -> Optional[Any]:
    try:
        r = SESSION.get(url, timeout=timeout)
        if r.status_code == 451:
            return {"__error": 451, "__url": url}
        r.raise_for_status()
        if "application/json" in r.headers.get("content-type", "") or r.text[:1] in "[{":
            return r.json()
        return r.text
    except Exception as e:
        log(f"GET 失败 {url} ：{e}")
        return None


def spot_get(path: str) -> Optional[Any]:
    last_err = None
    for base in SPOT_REST:
        data = http_get(base + path)
        if data is None:
            last_err = "network"
            continue
        if isinstance(data, dict) and data.get("__error") == 451:
            log(f"现货接口 {base} 返回 451（地区限制），尝试备用域名")
            last_err = 451
            continue
        return data
    log(f"所有现货 REST 均失败（最后原因 {last_err}）")
    return None


def fapi_get(path: str) -> Optional[Any]:
    for base in FAPI_REST:
        data = http_get(base + path)
        if data is None:
            continue
        if isinstance(data, dict) and data.get("__error") == 451:
            log(f"期货接口 {base} 被地区限制（451）")
            return None
        return data
    return None


def okx_get(path: str) -> Optional[Any]:
    data = http_get(OKX + path)
    if isinstance(data, dict) and data.get("code") == "0":
        return data.get("data")
    if data is not None:
        log(f"OKX 非成功响应 {path}：{str(data)[:200]}")
    return None


def load_config(path: Path) -> Dict[str, Any]:
    cfg = load_json(path, {})
    if not cfg:
        log(f"警告：未读到配置 {path}，使用内置默认")
        cfg = {
            "symbols": ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"],
            "price_alerts": [],
            "funding_abs_threshold": 0.0005,
            "volume_spike_ratio": 3.0,
            "volume_interval": "5m",
            "volume_lookback": 24,
            "liquidation_alert_usd": 1_000_000,
            "cooldown_minutes": 60,
            "calendar_impact": ["High"],
            "prefer_official_binance": True,
        }
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
            json={"chat_id": chat, "text": text, "parse_mode": "HTML"},
            timeout=20,
        )
        if r.status_code >= 400:
            log(f"Telegram 发送失败 {r.status_code}：{r.text[:300]}")
            return False
        log("Telegram 已发送")
        return True
    except Exception as e:
        log(f"Telegram 发送异常：{e}")
        return False


def cooled(state: Dict[str, Any], key: str, cooldown_min: float) -> bool:
    last = (state.get("alerts") or {}).get(key)
    if not last:
        return False
    try:
        return (now_ts() - float(last)) < cooldown_min * 60
    except Exception:
        return False


def mark_alert(state: Dict[str, Any], key: str) -> None:
    state.setdefault("alerts", {})[key] = now_ts()


def fmt_price(p: float) -> str:
    if p >= 1000:
        return f"{p:,.2f}"
    if p >= 1:
        return f"{p:.4f}".rstrip("0").rstrip(".")
    return f"{p:.8f}".rstrip("0").rstrip(".")


def fetch_tickers(symbols: List[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    data = spot_get("/api/v3/ticker/24hr")
    if not isinstance(data, list):
        # 退回单个查询
        for s in symbols:
            one = spot_get(f"/api/v3/ticker/24hr?symbol={s}")
            if isinstance(one, dict) and "lastPrice" in one:
                out[s] = one
        return out
    want = set(symbols)
    for row in data:
        sym = row.get("symbol")
        if sym in want or (not want and str(sym).endswith("USDT")):
            out[sym] = row
    return out


def fetch_funding(symbols: List[str]) -> Dict[str, Dict[str, Any]]:
    """优先币安 fapi；失败则用 OKX 永续。返回 {symbol: {rate, source, mark, oi}}"""
    result: Dict[str, Dict[str, Any]] = {}
    prem = fapi_get("/fapi/v1/premiumIndex")
    if isinstance(prem, list):
        for row in prem:
            sym = row.get("symbol")
            if sym in symbols:
                try:
                    result[sym] = {
                        "rate": float(row.get("lastFundingRate") or 0),
                        "mark": float(row.get("markPrice") or 0),
                        "source": "binance-fapi",
                    }
                except (TypeError, ValueError):
                    pass
    # 补齐：OKX
    missing = [s for s in symbols if s not in result]
    for sym in missing:
        inst = sym.replace("USDT", "-USDT-SWAP")
        if not inst.endswith("-USDT-SWAP"):
            inst = f"{sym}-SWAP"
        data = okx_get(f"/api/v5/public/funding-rate?instId={inst}")
        if data:
            try:
                result[sym] = {
                    "rate": float(data[0]["fundingRate"]),
                    "mark": None,
                    "source": "okx",
                }
            except Exception:
                pass
        time.sleep(0.08)
    # 持仓量（OKX 更可能在美国 IP 可用）
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
    # 用已收盘的 K 线（去掉最后一根未收盘）
    closed = data[:-1] if len(data) > lookback else data
    vols = []
    for k in closed:
        try:
            vols.append(float(k[5]))
        except (TypeError, ValueError, IndexError):
            pass
    if len(vols) < 5:
        return None
    last = vols[-1]
    prev = vols[:-1]
    prev_sorted = sorted(prev)
    median = prev_sorted[len(prev_sorted) // 2]
    if median <= 0:
        return None
    r = last / median
    if r >= ratio:
        return {"symbol": symbol, "ratio": r, "last": last, "median": median, "interval": interval}
    return None


def check_price_alerts(tickers, alerts, state, cooldown) -> List[str]:
    msgs = []
    for a in alerts or []:
        sym = (a.get("symbol") or "").upper()
        if not sym or sym not in tickers:
            continue
        try:
            px = float(tickers[sym]["lastPrice"])
        except Exception:
            continue
        chg = tickers[sym].get("priceChangePercent")
        above, below = a.get("above"), a.get("below")
        if above not in (None, "", 0) and px >= float(above):
            key = f"{sym}:above:{above}"
            if not cooled(state, key, cooldown):
                msgs.append(f"⬆️ {sym} 现价 {fmt_price(px)} 突破上限 {fmt_price(float(above))}（24h {chg}%）")
                mark_alert(state, key)
        if below not in (None, "", 0) and px <= float(below):
            key = f"{sym}:below:{below}"
            if not cooled(state, key, cooldown):
                msgs.append(f"⬇️ {sym} 现价 {fmt_price(px)} 跌破下限 {fmt_price(float(below))}（24h {chg}%）")
                mark_alert(state, key)
    return msgs


def check_funding(funding, threshold, state, cooldown) -> List[str]:
    msgs = []
    for sym, row in funding.items():
        rate = row.get("rate")
        if rate is None:
            continue
        if abs(rate) >= threshold:
            key = f"{sym}:funding:{round(rate, 6)}"
            # 同一方向的极端资金费在冷却期内只报一次（用符号分桶）
            key_dir = f"{sym}:funding:{'pos' if rate > 0 else 'neg'}"
            if cooled(state, key_dir, cooldown):
                continue
            pct = rate * 100
            src = row.get("source") or ""
            msgs.append(
                f"💸 {sym} 资金费率极端：{pct:.4f}%（来源 {src}，阈值 ±{threshold * 100:.4f}%）"
            )
            mark_alert(state, key_dir)
    return msgs


def check_volume(symbols, ratio, interval, lookback, state, cooldown) -> List[str]:
    msgs = []
    for sym in symbols:
        spike = volume_spike(sym, ratio, interval, lookback)
        if not spike:
            continue
        key = f"{sym}:volspike"
        if cooled(state, key, cooldown):
            continue
        msgs.append(
            f"📊 {sym} 成交量异动：最近一根 {spike['interval']} K 线成交量为中位数的 {spike['ratio']:.1f} 倍"
        )
        mark_alert(state, key)
        time.sleep(0.05)
    return msgs


def check_calendar(cfg, state, cooldown) -> List[str]:
    impacts = set(cfg.get("calendar_impact") or ["High"])
    data = http_get(FF_CALENDAR)
    if not isinstance(data, list):
        return []
    msgs = []
    now = datetime.now(timezone.utc)
    horizon = now + timedelta(hours=8)
    for ev in data:
        try:
            impact = ev.get("impact") or ""
            if impact not in impacts:
                continue
            raw = ev.get("date") or ""
            # 例如 2026-11-15T16:30:00-05:00
            dt = datetime.fromisoformat(raw)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            if not (now - timedelta(minutes=20) <= dt <= horizon):
                continue
            key = f"cal:{ev.get('country')}:{ev.get('title')}:{raw}"
            if cooled(state, key, max(cooldown, 360)):
                continue
            when = dt.astimezone().strftime("%m-%d %H:%M %Z")
            msgs.append(
                f"📅 宏观即将公布：{ev.get('country') or ''} {ev.get('title')}（{impact}）"
                f" 时间 {when}  前值 {ev.get('previous') or '—'}"
                f" 预测 {ev.get('forecast') or '—'}"
            )
            mark_alert(state, key)
        except Exception:
            continue
    return msgs


def run_poll(cfg, state, dry_run: bool) -> int:
    symbols = [s.upper() for s in (cfg.get("symbols") or [])]
    cooldown = float(cfg.get("cooldown_minutes") or 60)
    token, chat = telegram_creds(cfg)

    log(f"轮询开始，关注 {', '.join(symbols) or '（无）'}")
    tickers = fetch_tickers(symbols)
    if not tickers:
        log("未拿到现货行情，本轮跳过价格提醒")
    else:
        for s, t in tickers.items():
            if s in symbols:
                log(f"  {s}  {t.get('lastPrice')}  24h {t.get('priceChangePercent')}%  vol={t.get('quoteVolume')}")

    funding = fetch_funding(symbols)
    for s, f in funding.items():
        log(f"  资金费 {s} {f.get('rate')} ({f.get('source')})")

    msgs: List[str] = []
    msgs += check_price_alerts(tickers, cfg.get("price_alerts"), state, cooldown)
    msgs += check_funding(funding, float(cfg.get("funding_abs_threshold") or 0.0005), state, cooldown)
    msgs += check_volume(
        symbols,
        float(cfg.get("volume_spike_ratio") or 3.0),
        str(cfg.get("volume_interval") or "5m"),
        int(cfg.get("volume_lookback") or 24),
        state,
        cooldown,
    )
    msgs += check_calendar(cfg, state, cooldown)

    if msgs:
        header = "🚨 交易观察台提醒\n" + fmt_rome()
        send_telegram(token, chat, header + "\n" + "\n".join(msgs), dry_run)
    else:
        log("本轮没有新的提醒（或仍在冷却中）")
    return 0


def write_public(cfg) -> int:
    cal_path = ROOT / "public-data" / "calendar.json"
    eq_path = ROOT / "public-data" / "equities.json"
    cal_path.parent.mkdir(parents=True, exist_ok=True)

    cal = http_get(FF_CALENDAR)
    events = cal if isinstance(cal, list) else []
    save_json(cal_path, {
        "generated_at": iso_utc(),
        "source": FF_CALENDAR,
        "events": events,
    })
    log(f"已写入日历 {len(events)} 条 -> {cal_path}")

    quotes: Dict[str, Any] = {}
    tickers = cfg.get("equity_tickers") or DEFAULT_EQUITY_TICKERS
    for sym in tickers:
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
            # 用最近两个有效收盘估算 24h
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
                "exchange": meta.get("fullExchangeName") or meta.get("exchangeName"),
                "daily_closes": [
                    {"t": int(ts[i]), "c": closes[i]}
                    for i in range(min(len(ts), len(closes)))
                    if closes[i] is not None
                ][-30:],
            }
        except Exception as e:
            log(f"解析 {sym} 正股失败：{e}")
    save_json(eq_path, {
        "generated_at": iso_utc(),
        "source": "https://query1.finance.yahoo.com",
        "quotes": quotes,
    })
    log(f"已写入正股 {len(quotes)} 只 -> {eq_path}")
    return 0


# --------------- realtime websocket mode ---------------

def _ws_url_candidates(prefer_official: bool) -> Tuple[List[str], List[str]]:
    vision = "wss://data-stream.binance.vision/ws/!miniTicker@arr"
    official = [
        "wss://stream.binance.com:9443/ws/!miniTicker@arr",
        "wss://stream.binance.com:443/ws/!miniTicker@arr",
    ]
    fut = [
        "wss://fstream.binance.com/stream?streams=!forceOrder@arr/btcusdt@markPrice@1s/ethusdt@markPrice@1s/solusdt@markPrice@1s/bnbusdt@markPrice@1s/xrpusdt@markPrice@1s/dogeusdt@markPrice@1s",
    ]
    spot = (official + [vision]) if prefer_official else ([vision] + official)
    return spot, fut


def run_realtime(cfg, state, state_path: Path, dry_run: bool) -> int:
    try:
        import websocket  # websocket-client
    except ImportError:
        log("实时模式需要 websocket-client： pip install -r requirements.txt")
        return 2

    symbols = set(s.upper() for s in (cfg.get("symbols") or []))
    cooldown = float(cfg.get("cooldown_minutes") or 60)
    token, chat = telegram_creds(cfg)
    prefer = bool(cfg.get("prefer_official_binance", True))
    liq_min = float(cfg.get("liquidation_alert_usd") or 1_000_000)
    funding_th = float(cfg.get("funding_abs_threshold") or 0.0005)

    last_price: Dict[str, float] = {}
    last_poll = 0.0
    last_save = 0.0
    # 启动先做一轮 REST，避免 WS 未就绪时漏掉
    try:
        run_poll(cfg, state, dry_run)
        last_poll = now_ts()
        save_json(state_path, state)
    except Exception:
        log("启动轮询失败：\n" + traceback.format_exc())

    def emit(msgs: List[str]) -> None:
        if not msgs:
            return
        send_telegram(token, chat, "🚨 交易观察台（实时）\n" + fmt_rome() + "\n" + "\n".join(msgs), dry_run)
        save_json(state_path, state)

    def on_spot_message(_ws, message: str) -> None:
        nonlocal last_poll, last_save
        try:
            data = json.loads(message)
        except Exception:
            return
        rows = data if isinstance(data, list) else [data]
        alerts = []
        price_cfgs = { (a.get("symbol") or "").upper(): a for a in (cfg.get("price_alerts") or []) }
        for row in rows:
            sym = row.get("s")
            if not sym:
                continue
            try:
                px = float(row.get("c") or 0)
            except (TypeError, ValueError):
                continue
            last_price[sym] = px
            a = price_cfgs.get(sym)
            if not a:
                continue
            above, below = a.get("above"), a.get("below")
            if above not in (None, "", 0) and px >= float(above):
                key = f"{sym}:above:{above}"
                if not cooled(state, key, cooldown):
                    alerts.append(f"⬆️ {sym} 现价 {fmt_price(px)} 突破上限 {fmt_price(float(above))}")
                    mark_alert(state, key)
            if below not in (None, "", 0) and px <= float(below):
                key = f"{sym}:below:{below}"
                if not cooled(state, key, cooldown):
                    alerts.append(f"⬇️ {sym} 现价 {fmt_price(px)} 跌破下限 {fmt_price(float(below))}")
                    mark_alert(state, key)
        if alerts:
            emit(alerts)
        # 周期性补查资金费 / 成交量 / 日历（WS 覆盖不到或期货被墙时）
        if now_ts() - last_poll >= 180:
            last_poll = now_ts()
            try:
                extra: List[str] = []
                funding = fetch_funding(list(symbols))
                extra += check_funding(funding, funding_th, state, cooldown)
                extra += check_volume(
                    list(symbols),
                    float(cfg.get("volume_spike_ratio") or 3.0),
                    str(cfg.get("volume_interval") or "5m"),
                    int(cfg.get("volume_lookback") or 24),
                    state,
                    cooldown,
                )
                extra += check_calendar(cfg, state, cooldown)
                if extra:
                    emit(extra)
            except Exception:
                log("周期补查失败：\n" + traceback.format_exc())
        if now_ts() - last_save >= 30:
            last_save = now_ts()
            try:
                save_json(state_path, state)
            except Exception:
                pass

    def on_fut_message(_ws, message: str) -> None:
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
                if usd >= liq_min and sym in symbols or (usd >= liq_min * 3):
                    key = f"{sym}:liq:{int(now_ts() // 60)}"
                    if not cooled(state, key, min(cooldown, 15)):
                        alerts.append(
                            f"💥 爆仓 {sym} {'空' if side == 'BUY' else '多'} "
                            f"约 ${usd:,.0f} @ {fmt_price(px)}"
                        )
                        mark_alert(state, key)
            except Exception:
                return
        elif ev in ("markPriceUpdate", "markPrice"):
            try:
                sym = data.get("s")
                rate = float(data.get("r") or 0)
                if sym in symbols and abs(rate) >= funding_th:
                    key_dir = f"{sym}:funding:{'pos' if rate > 0 else 'neg'}"
                    if not cooled(state, key_dir, cooldown):
                        alerts.append(f"💸 {sym} 资金费率极端：{rate * 100:.4f}%（币安期货推送）")
                        mark_alert(state, key_dir)
            except Exception:
                return
        if alerts:
            emit(alerts)

    def connect_loop(urls: List[str], handler, name: str) -> None:
        import threading

        def run():
            idx = 0
            backoff = 1
            while True:
                url = urls[idx % len(urls)]
                log(f"{name} 连接 {url}")
                try:
                    ws = websocket.WebSocketApp(
                        url,
                        on_message=handler,
                        on_error=lambda _w, e: log(f"{name} 错误：{e}"),
                        on_close=lambda *_a: log(f"{name} 断开"),
                        on_open=lambda _w: log(f"{name} 已连接"),
                    )
                    # 若 8 秒内完全没数据，fstream 在部分地区会“假连接”
                    ws.run_forever(ping_interval=20, ping_timeout=10)
                except Exception as e:
                    log(f"{name} 异常：{e}")
                idx += 1
                log(f"{name} {backoff}s 后重连")
                time.sleep(backoff)
                backoff = min(backoff * 2, 30)

        t = threading.Thread(target=run, name=name, daemon=True)
        t.start()
        return t

    spot_urls, fut_urls = _ws_url_candidates(prefer)
    connect_loop(spot_urls, on_spot_message, "现货WS")
    connect_loop(fut_urls, on_fut_message, "期货WS")
    log("实时模式已启动（Ctrl+C 退出）")
    try:
        while True:
            time.sleep(5)
    except KeyboardInterrupt:
        log("收到中断，退出")
        save_json(state_path, state)
        return 0


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="交易观察台监控")
    p.add_argument("--config", default=str(ROOT / "config.json"))
    p.add_argument("--state", default=str(ROOT / ".monitor-state.json"))
    p.add_argument("--dry-run", action="store_true", help="只打印提醒，不发送 Telegram")
    p.add_argument("--realtime", action="store_true", help="WebSocket 常驻（VPS / 电脑）")
    p.add_argument("--write-public", action="store_true", help="刷新 public-data 日历和正股报价")
    args = p.parse_args(argv)

    cfg = load_config(Path(args.config))
    state_path = Path(args.state)
    state = load_json(state_path, {"alerts": {}})
    if not isinstance(state, dict):
        state = {"alerts": {}}

    try:
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
