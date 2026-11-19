#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""交易观察台监控：GitHub Actions 轮询 或 --realtime WebSocket 常驻。

Telegram 只推真正能影响价格的资讯（评分≥4）和高流动性永续上的共振机会
（放量+区间突破，或极端资金费+持仓骤变）。不推送评论、预测、综述、议员警告、
单独的资金费/溢价/自选涨跌。所有提醒带冷却、跨源故事去重与单轮约 3 条上限。
不是投资建议，不下单。
密钥只用环境变量 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID，不要写进仓库。
Worker 地址用环境变量 WORKER_URL 或 config 里的 worker_url（不是密钥）。
去重状态优先与 Cloudflare KV 同步（MONITOR_SECRET）；Actions cache 仅作后备。
"""
from __future__ import annotations

import argparse
import re
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
KNOWN_UNDER = {
    "AAPL","ABT","ADBE","AMD","AMZN","ARM","AVGO","AMC","BA","BABA","BAC","COIN",
    "COST","CRM","CRCL","CRWD","DIS","GME","GOOG","GOOGL","GS","HD","HOOD","IBM",
    "INTC","JNJ","JPM","KO","LLY","MA","META","MSFT","MSTR","MRVL","NFLX","NKE",
    "NVDA","ORCL","PLTR","PYPL","QCOM","SHOP","SMCI","SNDK","TSM","TSLA","UNH",
    "V","WMT","XOM","SPY","QQQ","IWM","DIA","VOO","IVV","TQQQ","SQQQ","SOXL",
    "SOXS","QQQM",
}
PREMIUM_CAP = 30.0
LEV_RE = re.compile(r"(UP|DOWN|BULL|BEAR|3L|3S|5L|5S)USDT$")
MIN_QUOTE_VOL = 50_000_000
SCAN_CAP = 40
VOL_SCAN_CAP = 12

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "trading-dashboard-monitor/2.0", "Accept": "application/json"})

WORKER_URL = ""


def now_ts() -> float:
    return time.time()


def iso_utc(ts: Optional[float] = None) -> str:
    return datetime.fromtimestamp(ts or now_ts(), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fmt_local(ts: Optional[float] = None) -> str:
    try:
        from zoneinfo import ZoneInfo
        dt = datetime.fromtimestamp(ts or now_ts(), tz=ZoneInfo("Europe/Rome"))
        return dt.strftime("%Y-%m-%d %H:%M:%S (欧洲/Rome)")
    except Exception:
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
    cfg.setdefault("volume_spike_ratio", 5.0)
    cfg.setdefault("min_quote_volume", MIN_QUOTE_VOL)
    cfg.setdefault("cooldown_minutes", 480)
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



def fetch_all_spot_tickers() -> List[Dict[str, Any]]:
    data = spot_get("/api/v3/ticker/24hr")
    return data if isinstance(data, list) else []


def liquid_universe(cfg: Dict[str, Any], all_tickers: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    cap = int(cfg.get("scan_cap") or SCAN_CAP)
    min_q = float(cfg.get("min_quote_volume") or MIN_QUOTE_VOL)
    watch = [s.upper() for s in (cfg.get("symbols") or [])]
    ranked: List[Tuple[float, str]] = []
    by: Dict[str, Dict[str, Any]] = {}
    for row in all_tickers:
        sym = row.get("symbol") or ""
        if not sym.endswith("USDT") or LEV_RE.search(sym):
            continue
        try:
            q = float(row.get("quoteVolume") or 0)
        except (TypeError, ValueError):
            q = 0.0
        by[sym] = row
        if q >= min_q:
            ranked.append((q, sym))
    ranked.sort(reverse=True)
    out: Dict[str, Dict[str, Any]] = {}
    for _, sym in ranked[:cap]:
        out[sym] = by[sym]
    for s in watch:
        if s in by:
            out[s] = by[s]
    return out


def merge_ts(a: Optional[Dict[str, Any]], b: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    out = dict(a or {})
    for k, v in (b or {}).items():
        try:
            if k not in out or float(v) > float(out[k]):
                out[k] = v
        except (TypeError, ValueError):
            out[k] = v
    return out


def pull_worker_state() -> Optional[Dict[str, Any]]:
    secret = os.environ.get("MONITOR_SECRET") or ""
    if not WORKER_URL or not secret:
        return None
    try:
        r = SESSION.get(
            WORKER_URL.rstrip("/") + "/monitor/state",
            headers={"Authorization": "Bearer " + secret, "Accept": "application/json"},
            timeout=12,
        )
        if r.status_code == 200:
            data = r.json()
            return data if isinstance(data, dict) else None
        log(f"读取 Worker 状态 HTTP {r.status_code}")
    except Exception as e:
        log(f"读取 Worker 状态失败：{e}")
    return None


def push_worker_state(state: Dict[str, Any]) -> None:
    secret = os.environ.get("MONITOR_SECRET") or ""
    if not WORKER_URL or not secret:
        return
    try:
        r = SESSION.put(
            WORKER_URL.rstrip("/") + "/monitor/state",
            headers={"Authorization": "Bearer " + secret, "Content-Type": "application/json"},
            json={"alerts": state.get("alerts") or {}, "oi_usd": state.get("oi_usd") or {}},
            timeout=12,
        )
        if r.status_code >= 300:
            log(f"写入 Worker 状态 HTTP {r.status_code}")
    except Exception as e:
        log(f"写入 Worker 状态失败：{e}")


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
    # 先拿全市场 OKX 持仓，把头部流动永续并进扫描列表
    oi_all = okx_get("/api/v5/public/open-interest?instType=SWAP")
    extra: List[str] = []
    if isinstance(oi_all, list):
        rows = []
        for x in oi_all:
            inst = x.get("instId") or ""
            if inst.endswith("-USDT-SWAP"):
                try:
                    rows.append((float(x.get("oiUsd") or 0), inst.replace("-USDT-SWAP", "USDT")))
                except (TypeError, ValueError):
                    pass
        rows.sort(reverse=True)
        extra = [s for _, s in rows[:SCAN_CAP]]
    want = []
    seen = set()
    for s in list(symbols) + extra:
        if s and s not in seen:
            seen.add(s)
            want.append(s)
    symbols = want[: max(SCAN_CAP, len(symbols))]
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
    # oi_all 已在函数开头拉取
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
    if r < ratio:
        return None
    candle = closed[-1]
    try:
        o, c = float(candle[1]), float(candle[4])
        chg = ((c / o) - 1) * 100 if o else 0.0
    except Exception:
        o = c = chg = 0.0
    prior = closed[:-1]
    try:
        hi = max(float(k[2]) for k in prior)
        lo = min(float(k[3]) for k in prior)
    except Exception:
        return None
    if not hi or not lo or not c:
        return None
    if c > hi:
        direction = "up"
    elif c < lo:
        direction = "down"
    else:
        return None
    return {"symbol": symbol, "ratio": r, "interval": interval, "chg": chg, "close": c, "dir": direction, "range_high": hi, "range_low": lo}


def underlying_of(xsym: str) -> Optional[str]:
    u = re.sub(r"[^A-Z0-9.]", "", (xsym or "").upper())
    if not u:
        return None
    if u in XSPECIAL:
        return XSPECIAL[u]
    core = u[:-1] if u.endswith("X") and len(u) >= 3 else u
    if core.startswith("W") and len(core) >= 3 and core[1:] in KNOWN_UNDER:
        core = core[1:]
    if core in KNOWN_UNDER:
        return core
    return None



NEWS_KEYWORDS = [
    "ETF", "SEC", "CFTC", "FOMC", "CPI", "PCE", "NFP", "Fed", "FED",
    "美联储", "加息", "降息", "利率", "非农", "通胀", "监管", "制裁", "起诉", "立案",
    "上币", "下架", "上线", "下线", "暂停充", "暂停提", "充提", "上市", "新币", "新上",
    "黑客", "被盗", "盗币", "攻击", "漏洞", "hack", "exploit", "breach",
    "listing", "delisting", "lawsuit", "approval", "approved", "Will List", "Will Delist", "New Listing", "opens trading",
    "破产", "暴雷", "停牌", "冻结", "调查", "罚单", "罚款",
    "现货ETF", "比特币ETF", "以太坊ETF",
]
_NEWS_RE = None


def _news_regex():
    global _NEWS_RE
    if _NEWS_RE is None:
        import re
        parts = []
        for k in NEWS_KEYWORDS:
            if k.isascii() and k.isalpha() and len(k) <= 4:
                parts.append(r"\b" + re.escape(k) + r"\b")
            else:
                parts.append(re.escape(k))
        # 短词 rate / ban 易误伤，要求独立词
        parts.extend([r"\brate(?:s| cut| hike)?\b", r"\bban(?:ned|s)?\b"])
        _NEWS_RE = re.compile("|".join(parts), re.I)
    return _NEWS_RE


def is_major_headline(title: str) -> bool:
    t = (title or "").strip()
    if len(t) < 6:
        return False
    return bool(_news_regex().search(t))


_OPINION_RE = re.compile(
    r"here'?s why|why it (?:matters|may)|opinion|analysis|recap|commentary|editorial|"
    r"interview|op-ed|column|long & short|long and short|what happened in crypto today|"
    r"here'?s what happened|price prediction|could beat|may be a mistake|analysts? say|should we (really )?(blame|care|worry)|is it time to|what it means for|"
    r"专家认为|点评|评论员|为何值得|今日要闻|每日回顾",
    re.I,
)
_WARN_RE = re.compile(
    r"senators? warn|\bsenators?:|legislators? (?:warn|urge)|could push|may (?:run|be|push)|"
    r"warn(?:s|ed)? (?:that|it)|警告(?:可能|或)|呼吁|建议国会",
    re.I,
)
_LISTING_RE = re.compile(
    r"will list|will delist|new listing|opens trading|will launch .{0,40}(perpetual|futures|合约)|"
    r"上币|下架|下线|新上.?币|将上架|将推出.{0,20}(永续|合约|期货)",
    re.I,
)
_ETF_RE = re.compile(
    r"etf.{0,40}(approv|reject|deny|inflow|outflow|flow)|现货etf.{0,20}(获批|批准|否决|流入|流出)|"
    r"(approv|reject|deny).{0,30}etf|(inflow|outflow).{0,20}(\$|usd|billion|million|亿)|净(流入|流出)",
    re.I,
)
_REG_RE = re.compile(
    r"\b(sec|cftc)\b.{0,40}(charg|sue|enforcement|settlement|fine|lawsuit|indict|order)|"
    r"filed (a )?(lawsuit|charges)|law (?:passed|signed|enacted)|court (?:order|rules|grants)|"
    r"冻结令|起诉|立案|罚单|执法|通过.{0,6}(法案|法律)",
    re.I,
)
_MACRO_RE = re.compile(
    r"\b(cpi|pce|nfp|nonfarm|fomc|fed)\b.{0,30}(print|comes? in|released?|holds?|cuts?|hikes?|raises?|keeps?)|"
    r"(cpi|非农|pce|利率).{0,10}(公布|落地|决议|维持|上调|下调|降息|加息)|降息.{0,6}(基点|bp)|加息.{0,6}(基点|bp)",
    re.I,
)
_OUTAGE_RE = re.compile(
    r"outage|halted withdrawals?|suspends? (withdrawals?|trading)|insolven|bankrupt|bank run|"
    r"暂停(充|提|交易)|宕机|提现暂停|破产|暴雷|停摆",
    re.I,
)
_UNLOCK_RE = re.compile(r"token unlock|cliff unlock|解锁.{0,10}(代币|token)|大额解锁", re.I)
_HACK_RE = re.compile(r"hack|exploit|breach|stolen|drained|被盗|盗币|攻击|漏洞利用|被黑", re.I)
_HACK_FOLLOW_RE = re.compile(r"court docs|court documents|freezing order|冻结令|recover stolen|investigation|investigat|after the (?:hack|exploit)|expands .{0,20}hack", re.I)
_NOT_LISTING_RE = re.compile(r"collateral asset|as collateral|抵押品|作为抵押|zero maker fee promotion", re.I)
_MAJOR_RE = re.compile(
    r"binance|coinbase|okx|bybit|kraken|bitfinex|bitget|upbit|gemini|tether|"
    r"uniswap|aave|lido|makerdao|maker\\b|币安|火币|欧易",
    re.I,
)
_TOP_UNLOCK_RE = re.compile(
    r"unlock.{0,20}(btc|eth|sol|bnb|xrp|doge|ada|avax|dot|link|sui|near|apt)|"
    r" (btc|eth|sol|bnb|xrp|doge|ada|avax|sui).{0,20}unlock",
    re.I,
)


def parse_usd(text: str):
    t = (text or "").replace(",", " ")
    pats = [
        (r"\$?\s*(\d+(?:\.\d+)?)\s*(?:billion|bn)\b", 1e9),
        (r"\$\s*(\d+(?:\.\d+)?)\s*b\b", 1e9),
        (r"(\d+(?:\.\d+)?)\s*亿美元", 1e8),
        (r"\$?\s*(\d+(?:\.\d+)?)\s*(?:million|mm|mio)\b", 1e6),
        (r"\$\s*(\d+(?:\.\d+)?)\s*m\b", 1e6),
        (r"(\d+(?:\.\d+)?)\s*万美元", 1e4),
        (r"(\d+(?:\.\d+)?)\s*亿(?!美元)", 1e8),
    ]
    for pat, mul in pats:
        m = re.search(pat, t, re.I)
        if m:
            return float(m.group(1)) * mul
    return None


def is_low_value_news(title: str, source: str = "", excerpt: str = "") -> bool:
    blob = f"{title} {excerpt}"
    if _OPINION_RE.search(blob) or _OPINION_RE.search(title or ""):
        return True
    if _WARN_RE.search(blob):
        return True
    if re.search(r"newsletter|daily digest|in today'?s (letter|newsletter)", title or "", re.I) and not _HACK_RE.search(blob) and not _LISTING_RE.search(blob):
        return True
    if "华尔街见闻" in (source or "") and not any(r.search(blob) for r in (_MACRO_RE, _ETF_RE, _REG_RE, _HACK_RE)):
        if not re.search(r"bitcoin|btc|eth|crypto|比特币|以太|美联储|非农|cpi|etf", blob, re.I):
            return True
    return False


def classify_boost(title: str, source: str = "", excerpt: str = ""):
    blob = f"{title} {excerpt}"
    if not _NOT_LISTING_RE.search(title or "") and (("币安" in (source or "") and _LISTING_RE.search(title or "")) or _LISTING_RE.search(title or "") or _LISTING_RE.search(blob)):
        return "listing"
    if _HACK_RE.search(blob) and not _HACK_FOLLOW_RE.search(blob):
        usd = parse_usd(blob)
        if (usd is not None and usd >= 10_000_000) or _MAJOR_RE.search(title or "") or _MAJOR_RE.search(blob):
            return "hack"
        return None
    if _ETF_RE.search(title or ""):
        return "etf"
    if _REG_RE.search(blob) and not _WARN_RE.search(blob):
        return "reg"
    if _MACRO_RE.search(blob) and not re.search(r"may be|here'?s why|可能是错误", blob, re.I):
        return "macro"
    if _OUTAGE_RE.search(blob) and _MAJOR_RE.search(blob):
        return "outage"
    if _UNLOCK_RE.search(blob) and (_TOP_UNLOCK_RE.search(blob) or _MAJOR_RE.search(blob)):
        return "unlock"
    return None


def default_why(cat: str) -> str:
    return {
        "listing": "交易所正式上架或下架/上线永续，相关合约流动性与价格可能立刻重定价。",
        "hack": "大规模被盗或攻击会引发避险抛售，并冲击涉事交易所或协议的代币。",
        "etf": "现货 ETF 审批或大额资金进出，会直接改变比特币等的买盘或卖压。",
        "reg": "监管执法或法律落地可能改变合规预期，影响交易所与代币估值。",
        "macro": "利率或重磅宏观数据公布，通常会带动风险资产整体波动。",
        "outage": "大型交易所故障或兑付问题会打断交易并可能引发挤兑式抛售。",
        "unlock": "主流币大额解锁增加流通供应，短线常有抛压。",
    }.get(cat) or "若属实，可能立刻影响相关资产价格。"


def story_key(title: str) -> str:
    t = re.sub(r"https?:\/\/\S+", " ", (title or "").lower())
    t = re.sub("[^a-z0-9\u4e00-\u9fff$]+", " ", t)
    t = re.sub(r"\b(the|a|an|and|or|of|in|on|for|to|as|with|from|by|at|its|is|are|was|will|says?|after|over)\b", " ", t)
    parts = [w for w in t.split() if len(w) >= 3 or re.search("[0-9\u4e00-\u9fff]", w)][:8]
    return " ".join(parts)


def local_score_news(it: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    title = str(it.get("title") or "")
    excerpt = f"{it.get('excerpt') or ''} {it.get('summaryZh') or ''}"
    source = str(it.get("source") or "")
    if is_low_value_news(title, source, excerpt):
        return None
    cat = classify_boost(title, source, excerpt)
    if not cat:
        return None
    out = dict(it)
    out["score"] = 4
    out["whyZh"] = default_why(cat)
    out["category"] = cat
    return out


def parse_source_time(raw, now_ms: Optional[float] = None) -> float:
    """只解析来源原始发布时间，绝不回退到抓取时刻。返回毫秒时间戳，不可靠则为 0。"""
    if raw in (None, ""):
        return 0.0
    now = (now_ms if now_ms is not None else now_ts() * 1000)
    try:
        if isinstance(raw, (int, float)) or (isinstance(raw, str) and re.fullmatch(r"\d+(?:\.\d+)?", str(raw).strip())):
            ms = float(raw)
            if ms < 1e12:
                ms *= 1000
        else:
            from email.utils import parsedate_to_datetime
            s = str(raw).strip()
            try:
                dt = parsedate_to_datetime(s)
            except Exception:
                dt = None
            if dt is None:
                # ISO 8601
                try:
                    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
                except Exception:
                    return 0.0
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            ms = dt.timestamp() * 1000
        if ms < 1e12 or ms > now + 5 * 60 * 1000:
            return 0.0
        return ms
    except Exception:
        return 0.0


def extract_published_at(title: str, t: float = 0, source: str = "") -> float:
    # 标题里的业务日期不是发布时间；无来源时间戳则不推。
    _ = (title, source)
    return parse_source_time(t)


def filter_news_for_push(items: List[Dict[str, Any]], hours: float = 2) -> List[Dict[str, Any]]:
    cutoff = now_ts() * 1000 - hours * 3600 * 1000
    windowed = []
    for it in items:
        title = str(it.get("title") or "").strip()
        url = str(it.get("url") or "").strip()
        if not title or not url:
            continue
        try:
            ts = extract_published_at(title, float(it.get("t") or 0), str(it.get("source") or ""))
        except (TypeError, ValueError):
            ts = extract_published_at(title, 0, str(it.get("source") or ""))
        if not ts or ts < cutoff:
            continue
        windowed.append(it)

    passed = None
    secret = os.environ.get("MONITOR_SECRET") or ""
    base = (WORKER_URL or "").rstrip("/")
    if base and secret:
        try:
            r = SESSION.post(
                base + "/monitor/filter-news?hours=" + str(int(hours)),
                headers={"Authorization": "Bearer " + secret, "Content-Type": "application/json"},
                json={"items": windowed, "hours": hours},
                timeout=45,
            )
            if r.ok:
                data = r.json()
                rows = data.get("newTitles") or data.get("newPassed") or []
                if isinstance(rows, list):
                    passed = rows
                    log(f"Worker 新闻过滤：旧规则 {data.get('oldCount')} 条，新规则 {data.get('newCount')} 条")
        except Exception as e:
            log(f"Worker 新闻过滤失败，改用本地硬规则：{e}")
    if passed is None:
        scored = [x for x in (local_score_news(it) for it in windowed) if x]
        # 跨源去重
        groups: Dict[str, List[Dict[str, Any]]] = {}
        order = []
        for it in scored:
            k = story_key(str(it.get("titleZh") or it.get("title") or "")) or str(it.get("url") or "").split("?")[0]
            if k not in groups:
                groups[k] = []
                order.append(k)
            groups[k].append(it)
        passed = [groups[k][0] for k in order]
    return passed



def clean_news_url(url: str) -> str:
    from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse
    try:
        u = urlparse(url)
        q = [(k, v) for k, v in parse_qsl(u.query, keep_blank_values=True)
             if not (k.lower().startswith("utm_") or k.lower() in {
                 "fbclid","gclid","gclsrc","dclid","msclkid","twclid","yclid",
                 "mc_cid","mc_eid","igshid","si","icid","cmpid","ncid","spm","scm",
                 "ref","ref_src","_ga","_gl","wbraid","gbraid","ocid","srsltid","mkt_tok",
             })]
        return urlunparse((u.scheme, u.netloc, u.path, u.params, urlencode(q), ""))
    except Exception:
        return url


def news_summary(title: str, max_len: int = 80) -> str:
    s = " ".join((title or "").split())
    if len(s) <= max_len:
        return s
    return s[: max_len - 1] + "…"



def fetch_binance_announcements() -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    hosts = ["https://www.binance.info", "https://www.binance.com"]
    paths = [
        "/bapi/composite/v1/public/cms/article/catalog/list/query?catalogId=48&pageNo=1&pageSize=8",
        "/bapi/composite/v1/public/cms/article/catalog/list/query?catalogId=49&pageNo=1&pageSize=8",
        "/bapi/composite/v1/public/cms/article/catalog/list/query?catalogId=161&pageNo=1&pageSize=8",
        "/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=10",
    ]
    for host in hosts:
        got = 0
        for path in paths:
            data = _raw_get(host + path, 12)
            arts: List[Dict[str, Any]] = []
            if isinstance(data, dict):
                d = data.get("data") or {}
                if isinstance(d.get("articles"), list):
                    arts.extend(d["articles"])
                for cat in d.get("catalogs") or []:
                    if isinstance(cat, dict) and isinstance(cat.get("articles"), list):
                        arts.extend(cat["articles"])
            for a in arts:
                title = str(a.get("title") or "").strip()
                code = str(a.get("code") or "").strip()
                if not title:
                    continue
                url = f"https://www.binance.com/zh-CN/support/announcement/{code}" if code else "https://www.binance.com/zh-CN/support/announcement"
                ts = parse_source_time(a.get("publishDate") or a.get("releaseDate") or a.get("firstOpenDate") or 0)
                items.append({"title": title, "url": url, "source": "币安公告", "t": ts, "pubOk": bool(ts), "important": True, "code": code})
                got += 1
        if got:
            break
    # unique
    seen = set()
    uniq = []
    for it in items:
        if it["title"] in seen:
            continue
        seen.add(it["title"])
        uniq.append(it)
    need = [it for it in uniq if not it.get("pubOk") and it.get("code")][:8]
    for it in need:
        code = it.get("code")
        for host in hosts:
            data = _raw_get(f"{host}/bapi/composite/v1/public/cms/article/detail/query?articleCode={code}", 8)
            if isinstance(data, dict):
                ts = parse_source_time(((data.get("data") or {}) if isinstance(data.get("data"), dict) else {}).get("publishDate")
                    or ((data.get("data") or {}) if isinstance(data.get("data"), dict) else {}).get("releaseDate")
                    or 0)
                if ts:
                    it["t"] = ts
                    it["pubOk"] = True
                    break
    for it in uniq:
        it.pop("code", None)
    return uniq[:12]


def push_news_cache(source: str, items: List[Dict[str, Any]]) -> None:
    secret = os.environ.get("MONITOR_SECRET") or ""
    if not WORKER_URL or not secret or not items:
        return
    try:
        r = SESSION.post(
            WORKER_URL.rstrip("/") + "/news/cache",
            headers={"Authorization": "Bearer " + secret, "Content-Type": "application/json"},
            json={"source": source, "items": items},
            timeout=12,
        )
        if r.status_code >= 300:
            log(f"写入新闻缓存 HTTP {r.status_code}")
        else:
            log(f"已把 {len(items)} 条{source}写入 Worker 缓存")
    except Exception as e:
        log(f"写入新闻缓存失败：{e}")


def fetch_news_items() -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    bn = fetch_binance_announcements()
    if bn:
        items.extend(bn)
        push_news_cache("币安公告", bn)
    if WORKER_URL:
        data = _raw_get(WORKER_URL.rstrip("/") + "/news/zh", 15)
        if isinstance(data, dict):
            items.extend(data.get("items") or [])
    if not items:
        # Worker 不可用时，直连华尔街见闻公开接口
        data = _raw_get(
            "https://api-one-wscn.awtmt.com/apiv1/content/information-flow?channel=global-channel&limit=20",
            15,
        )
        if isinstance(data, dict):
            for it in ((data.get("data") or {}).get("items") or []):
                r = it.get("resource") or {}
                title = str(r.get("title") or r.get("content_short") or "").strip()
                url = str(r.get("uri") or r.get("source_uri") or "").strip()
                ts = r.get("display_time") or 0
                try:
                    ts = int(ts)
                    if ts < 1e12:
                        ts *= 1000
                except Exception:
                    ts = 0
                if title and url:
                    items.append({"title": title, "url": url, "source": "华尔街见闻", "t": ts})
    return items


def radar_messages(cfg: Dict[str, Any], state: Dict[str, Any], tickers, funding) -> List[str]:
    rd = cfg.get("radar") or {}
    cooldown = float(cfg.get("cooldown_minutes") or 180)
    msgs: List[str] = []
    symbols = [s.upper() for s in (cfg.get("symbols") or [])]
    # 放量扫描：流动永续（传入的 tickers 已按成交额截断）优先，上限防止过慢
    vol_syms = list(tickers.keys())
    def _qv(sym: str) -> float:
        try:
            return float((tickers.get(sym) or {}).get("quoteVolume") or 0)
        except (TypeError, ValueError):
            return 0.0
    vol_syms = sorted(set(vol_syms) | set(symbols), key=_qv, reverse=True)[: int(cfg.get("volume_scan_cap") or VOL_SCAN_CAP)]

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

    max_total = int(cfg.get("max_alerts_per_run") or 3)
    base_n = len(msgs)  # 用户自设价格提醒不占机会名额
    min_q = float(cfg.get("min_quote_volume") or MIN_QUOTE_VOL)
    th_f = float(cfg.get("funding_abs_threshold") or 0.001)
    oi_th = float(rd.get("oi_surge_pct") or 10)
    opp_cd = float(cfg.get("cooldown_minutes") or 480)
    used = set()

    # 资金费极端 + 持仓骤变（共振）
    prev_oi = state.setdefault("oi_usd", {})
    next_oi = dict(prev_oi)
    for sym, row in funding.items():
        oi = row.get("oi_usd")
        if oi:
            next_oi[sym] = oi
    for sym, row in funding.items():
        if len(msgs) - base_n >= max_total:
            break
        if _qv(sym) < min_q:
            continue
        rate = row.get("rate")
        oi = row.get("oi_usd")
        if rate is None or abs(rate) < th_f or not oi:
            continue
        old = prev_oi.get(sym)
        if not old:
            continue
        oi_chg = (oi / old - 1) * 100
        if abs(oi_chg) < oi_th:
            continue
        key = f"opp:{sym}"
        if cooled(state, key, opp_cd):
            continue
        last = (tickers.get(sym) or {}).get("lastPrice")
        px_move = 0.0
        try:
            px_move = float((tickers.get(sym) or {}).get("priceChangePercent") or 0)
        except (TypeError, ValueError):
            px_move = 0.0
        crowded_long = rate > 0
        direction = "偏空警戒" if crowded_long else "偏多警戒"
        side = "多头付费，拥挤多头" if crowded_long else "空头付费，拥挤空头"
        pxbit = f"，现价 {fmt_price(float(last))}" if last else ""
        msgs.append(
            f"💸 资金费极端 + 持仓骤变 {sym}（{direction}）\n"
            f"资金费率 {(rate * 100):.4f}%（{side}），持仓 {oi_chg:+.1f}% 至约 ${oi:,.0f}{pxbit}，24h 价格 {px_move:+.2f}%\n"
            f"{chart_link(cfg, sym)}"
        )
        mark(state, key)
        used.add(sym)
    state["oi_usd"] = next_oi

    # 放量 + 近端区间突破
    ratio = float(cfg.get("volume_spike_ratio") or 5.0)
    interval = str(cfg.get("volume_interval") or "5m")
    lookback = int(cfg.get("volume_lookback") or 24)
    for sym in vol_syms:
        if len(msgs) - base_n >= max_total:
            break
        if _qv(sym) < min_q or sym in used:
            continue
        spike = volume_spike(sym, ratio, interval, lookback)
        if not spike:
            continue
        key = f"opp:{sym}"
        if cooled(state, key, opp_cd):
            continue
        direction = "偏多" if spike.get("dir") == "up" else "偏空"
        hi, lo, close = spike.get("range_high"), spike.get("range_low"), spike.get("close")
        level = f"站上近 2 小时区间高点 {hi}" if spike.get("dir") == "up" else f"跌破近 2 小时区间低点 {lo}"
        qv = _qv(sym)
        qbit = f"，24h 成交约 ${qv:,.0f}" if qv else ""
        msgs.append(
            f"📊 放量突破 {sym}（{direction}）\n"
            f"5m 成交量为近端中位数的 {spike['ratio']:.1f} 倍，收 {fmt_price(close)} {level}（区间 {lo}–{hi}）{qbit}\n"
            f"{chart_link(cfg, sym)}"
        )
        mark(state, key)
        used.add(sym)
        time.sleep(0.05)

    # 重要新闻：优先走 Worker 评分（≥4），失败则用本地硬类别
    news_room = max(0, min(2, max_total - len(msgs)))
    if news_room:
        news_cd = float(rd.get("news_cooldown_hours") or 24) * 60
        for it in filter_news_for_push(fetch_news_items(), hours=2):
            if news_room <= 0:
                break
            title = str(it.get("title") or "").strip()
            url = str(it.get("url") or "").strip()
            if not title or not url:
                continue
            url_key = "news:url:" + (clean_news_url(url).split("?")[0].rstrip("/")[:200])
            sk = story_key(str(it.get("titleZh") or title)) or story_key(title)
            story_id = ("news:story:" + sk[:180]) if sk else ""
            if any(cooled(state, k, 30 * 24 * 60) for k in (url_key, "news:" + url_key[len("news:url:"):], story_id, ("news:" + sk[:180] if sk else "")) if k):
                continue
            src = it.get("source") or "资讯"
            zh_title = str(it.get("titleZh") or title).strip()
            why = str(it.get("whyZh") or "").strip()
            link = clean_news_url(url)
            piece = f"📰 {zh_title}"
            if why:
                piece += f"\n为何影响价格：{why}"
            pub = parse_source_time(it.get("t") or 0)
            if pub:
                piece += f"\n发布时间：{fmt_local(pub / 1000 if pub > 1e12 else pub)}"
            piece += f"\n来源：{src}\n{link}"
            msgs.append(piece)
            mark(state, url_key)
            if story_id:
                mark(state, story_id)
            news_room -= 1
    return msgs


def run_poll(cfg, state, dry_run: bool) -> int:
    watch = [s.upper() for s in (cfg.get("symbols") or [])]
    token, chat = telegram_creds(cfg)
    all_tickers = fetch_all_spot_tickers()
    tickers = liquid_universe(cfg, all_tickers)
    if not tickers:
        tickers = fetch_tickers(watch)
    scan = list(tickers.keys())
    log(f"轮询开始，扫描 {len(scan)} 个流动 USDT 交易对（自选 {', '.join(watch) or '无'}）")
    for s in watch:
        tkr = tickers.get(s)
        if tkr:
            log(f"  {s}  {tkr.get('lastPrice')}  24h {tkr.get('priceChangePercent')}%")
    funding = fetch_funding(scan)
    for s, f in funding.items():
        log(f"  资金费 {s} {f.get('rate')} ({f.get('source')})")
    msgs = radar_messages(cfg, state, tickers, funding)
    if msgs:
        # 单轮最多 4 条，避免刷屏
        cap = int(cfg.get("max_alerts_per_run") or 3)
        body = "📡 观察台提醒\n" + fmt_local() + "\n\n" + "\n\n".join(msgs[:cap]) + footer()
        send_telegram(token, chat, body, dry_run)
        if len(msgs) > cap:
            log(f"本轮另有 {len(msgs) - cap} 条因单轮上限未发出")
    else:
        log("本轮没有新的提醒（或仍在冷却中）")
    return 0


def write_public(cfg) -> int:
    cal_path = ROOT / "public-data" / "calendar.json"
    eq_path = ROOT / "public-data" / "equities.json"
    cal_path.parent.mkdir(parents=True, exist_ok=True)
    cal = http_get(FF_CALENDAR)
    events = cal if isinstance(cal, list) else []
    src = FF_CALENDAR
    if not events and WORKER_URL:
        wcal = _raw_get(WORKER_URL.rstrip("/") + "/calendar", 12)
        if isinstance(wcal, dict) and isinstance(wcal.get("events"), list) and wcal["events"]:
            events = wcal["events"]
            src = "worker-cache"
            log("Forex Factory 失败，改用 Worker 日历缓存")
    save_json(cal_path, {"generated_at": iso_utc(), "source": src, "events": events, "stale": src == "worker-cache"})
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
        send_telegram(token, chat, "📡 观察台提醒（实时）\n" + fmt_local() + "\n\n" + "\n\n".join(msgs[:int(cfg.get("max_alerts_per_run") or 3)]) + footer(), dry_run)
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
    remote = None if (args.test_ping or args.write_public) else pull_worker_state()
    if remote:
        state["alerts"] = merge_ts(state.get("alerts"), remote.get("alerts"))
        state["oi_usd"] = merge_ts(state.get("oi_usd"), remote.get("oi_usd"))
        last = remote.get("lastRun") or {}
        if last.get("at"):
            log(f"已合并 Worker 状态（上次 {last.get('atRome') or last.get('at')}，trigger={last.get('trigger')}）")
    try:
        if args.test_ping:
            return test_ping(cfg, args.dry_run)
        if args.write_public:
            return write_public(cfg)
        if args.realtime:
            return run_realtime(cfg, state, state_path, args.dry_run)
        rc = run_poll(cfg, state, args.dry_run)
        save_json(state_path, state)
        push_worker_state(state)
        return rc
    except Exception:
        log("未处理异常：\n" + traceback.format_exc())
        try:
            save_json(state_path, state)
            push_worker_state(state)
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
