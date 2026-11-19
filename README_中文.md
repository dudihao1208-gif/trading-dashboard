# 交易观察台 v2

独立运行的加密货币 + 代币化美股观察台（Vite + React）。页面在浏览器里拉公开行情；机会雷达可把信号推到 Telegram。不依赖任何付费 AI，也不会自动下单。

> 仅供观察，不构成投资建议。下单请在交易所由你自己确认。

线上地址：https://dudihao1208-gif.github.io/trading-dashboard/

---

## 手机（iPhone）怎么用

1. 用 **Safari** 打开上面的地址（不要用微信/电报内置浏览器）。
2. 分享 → **添加到主屏幕**。
3. 在「我的 → 预警」里用大按钮按现价 ±3% / ±5% / ±8% 设阈值，需要的话再开浏览器通知（iOS 16.4+，且必须从主屏幕图标进入）。锁屏后台请靠 Telegram。

五个分栏：**看盘、图表、衍生品、雷达、我的**。桌面浏览器会自动换成「左侧自选 + 主图 + 右侧盘口/成交」的终端布局。

---

## Telegram 机会雷达

主调度是 **Cloudflare Worker Cron**（价格提醒每 1 分钟，新闻与机会雷达每 10 分钟），去重/冷却状态存在 Cloudflare KV，不依赖 GitHub 的定时任务是否准时。GitHub Actions 里同名工作流仍保留作备份，并与 Worker 共享状态（需 `MONITOR_SECRET`）。GitHub `schedule` 在新仓库上经常长时间不触发，且即便触发也常有延迟，最短约 5 分钟，**不是实时**。

页面「机会雷达」和 Telegram 都**不根据恐慌贪婪等情绪指数发信号**。

Telegram 只推真正有交易意义的条目（应用内资讯/雷达仍可更宽）：

- 能影响价格的既成事实：币安上币/下架/永续上线、约 1000 万美元以上或波及大所/大协议的攻击、现货 ETF 批准/否决或大额资金流、SEC/CFTC 执法或法律通过（不含议员警告或评论文章）、美联储/CPI/非农落地、大所停摆或兑付问题、主流币大额解锁。由模型按 1–5 分评分，只推 ≥4 分；评论、分析、预测、综述丢弃；同一事件按规范化链接和故事指纹去重。只推来源原始发布时间（pubDate / 公告时间，带时区）在最近 2 小时内的条目，没有可靠发布时间的不推；每条带一句「为何影响价格」和欧洲/Rome 发布时间。
- 高流动性永续（24h 成交额至少约 5000 万美元）上的共振机会：放量并突破近端区间，或资金费极端且持仓量骤变。推送含方向和关键价位/数字。同一标的默认 8 小时冷却。
- 你在 `config.json` 里明确写的价格突破。

单轮机会+新闻大约最多 3 条。阈值在 `config.json` 的 `radar` 段，**不要把密钥写进这个文件**。密钥只用环境变量或 Wrangler / Actions Secrets。

状态查询（公开，无密钥）：`https://trading-dashboard-proxy.2770818829.workers.dev/monitor/status`

## Cloudflare Worker（已默认接入）

线上站点已默认使用：

`https://trading-dashboard-proxy.2770818829.workers.dev`

CORS 仅允许 `https://dudihao1208-gif.github.io`。一般不用改地址；若要换代理或清空降级，可在「我的 → 设置」覆盖。

默认解锁：持仓量历史、多空比、主动买入量、加密资讯（币安公告、华尔街见闻、CoinDesk / The Block / Cointelegraph 等，中文源能通的一并纳入）、正股 Yahoo 报价、宏观日历缓存（Forex Factory 限流时继续返回上次成功的数据并标过期）。Worker 同时每 10 分钟跑机会雷达并给 Telegram 推送。资金费热力图：浏览器优先用币安期货 WebSocket（意大利等地区）；美国 IP 或推送失败时改走 OKX / CoinGecko。币安期货 REST 从 Worker 所在网络常被拦截，页面不再用浏览器直连 fapi（避免控制台报错）。

Worker 只代理白名单里的公开只读接口，不是开放代理。源码在 `worker/src/index.ts`。监控脚本可通过非密钥环境变量或配置项 `WORKER_URL` / `worker_url` 在直连失败时走同一代理。

---

## 本地开发

```bash
npm install
npm run dev
# 构建： npm run build && npm run preview
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export TELEGRAM_BOT_TOKEN=...   # 不要提交
export TELEGRAM_CHAT_ID=...
python monitor.py --dry-run
python monitor.py --test-ping   # 只发一条标明测试的连通消息
```

---

## 数据与地区限制

现货优先使用 `data-api.binance.vision` / `data-stream.binance.vision`（美国 IP 也可跨域）。官方 `api.binance.com` 仅作后备。期货推送在部分地区不可用，界面会显示「期货不可用」，不会一直停在「连接中」。资金费、持仓量等会改走 OKX 或 CoinGecko。宏观日历和美股正股由 Worker 缓存，并尽量由 Actions 写入 `public-data/`（源站无浏览器 CORS）。日历/正股/盘口会显示「更新于 / 已过期」。

---

## 文件

- `src/`：观察台前端（Vite + React + TypeScript）
- `monitor.py`：监控与雷达
- `config.json` / `config.example.json`：阈值（无密钥）
- `worker/` + `wrangler.toml`：已部署的只读代理
- `.github/workflows/`：Pages 构建、Monitor、刷新 public-data、Keepalive（防止 60 天停跑）


## 图表均线、模拟盘与价格提醒

- 图表会向回分页拉取足够的**真实**币安 K 线（通常 数百～上千根）再计算 EMA / MA / BOLL / MACD / ATR，不显示半成品估算值。新上线的期货（如 ANTUSDT 代币化股票永续）成交价历史可能很短，会改用更长的**标记价格** K 线，以便与币安 App 均线一致。最新一根随行情同步。
- 期货 REST 优先走 `https://www.binance.com/fapi`（美国 IP 也可访问，且允许浏览器跨域）。官方 `fapi.binance.com` 在美国常返回 451，Worker 也不依赖它。现货 K 线仍用 `data-api.binance.vision`。
- 「图表」页有**模拟盘**：开多/开空/平多/平空均需确认，不会用回车直接下单；预览阶段按交易所规则校验（最小名义额至少 100 USDT、步进、余额），不通过则按钮不可点。仓位展示保证金、强平价、未实现盈亏、ROE、资金费和手续费，并在图上标出开仓/止盈/止损/强平线。下单接口与实盘执行层分离，目前只实现模拟，不索取币安密钥。
- 价格提醒可在「我的 → 预警」自由增删改（涨到/跌到/涨跌幅、一次或重复）。经 Telegram 配对码绑定后，存在 Worker KV，每 1 分钟用币安标记价检查并推送（罗马时间）。新闻与机会雷达规则不变：只推重大且 2 小时内的资讯。
