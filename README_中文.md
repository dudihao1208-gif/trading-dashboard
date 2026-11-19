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

## Telegram 机会雷达（默认免费：GitHub Actions）

仓库 Settings → Secrets 中配置：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

工作流 **Trading Monitor** 约每 10 分钟轮询一次（GitHub 定时任务经常会延迟，不是实时）。命中下列条件且通过冷却后，会推一条中文说明，并带图表链接：

- 自选大波动、放量、极端资金费率
- 持仓量相对上次观察骤变
- 恐慌贪婪极端
- 代币化美股相对正股溢价/折价走阔
- 即将公布的高影响宏观数据
- 你在 `config.json` 里填写的价格上下限（默认为空，避免无意义刷屏）

单轮最多 4 条；同类信号有 3 小时（情绪 24 小时、溢价 12 小时）冷却。阈值在 `config.json` 的 `radar` 段，**不要把密钥写进这个文件**。

第一次手动跑：Actions → Trading Monitor → Run workflow。

**真正实时**：在非美国区域的云主机上：

```bash
git clone https://github.com/dudihao1208-gif/trading-dashboard.git
sudo bash trading-dashboard/install.sh
# 编辑 /etc/trading-dashboard/env 填入 Telegram 密钥后
sudo systemctl restart trading-monitor
```

请把云主机建在法兰克福 / 东京 / 新加坡等区域。币安主站在美国 IP 上常返回 451。

---

## Cloudflare Worker（可选，请自行部署）

未配置 Worker 时，观察台仍可用：现货实时行情、K 线（均线/MACD/成交量）、盘口与成交、资金费热力图、机会雷达（部分信号）、美股对比、宏观日历。

配置后可解锁：持仓量历史、多空比、主动买卖趋势、中文资讯。

仓库里已有 `worker/src/index.ts` 与 `wrangler.toml`。本项目**不会**代你创建 Cloudflare 账号或执行发布。你自己可以：

```bash
npm i -g wrangler
wrangler login
cd trading-dashboard
wrangler deploy
```

把得到的 `https://xxxx.workers.dev` 填进观察台「我的 → 设置」，或在 Pages 的 Actions 里加构建变量 `VITE_WORKER_URL`（不是 Telegram Secret）。

Worker 只代理白名单里的公开只读接口，不是开放代理。

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

现货优先使用 `data-api.binance.vision` / `data-stream.binance.vision`（美国 IP 也可跨域）。官方 `api.binance.com` 仅作后备。期货推送在部分地区不可用，界面会显示「期货不可用」，不会一直停在「连接中」。资金费、持仓量等会改走 OKX 或 CoinGecko。宏观日历和美股正股由 Actions 写入 `public-data/`（源站无浏览器 CORS）。

---

## 文件

- `src/`：观察台前端（Vite + React + TypeScript）
- `monitor.py`：监控与雷达
- `config.json` / `config.example.json`：阈值（无密钥）
- `worker/` + `wrangler.toml`：可选代理
- `.github/workflows/`：Pages 构建、Monitor、刷新 public-data、Keepalive（防止 60 天停跑）
