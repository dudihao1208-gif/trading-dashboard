# 交易观察台（独立运行，不依赖任何 AI）

一个可以自己托管、自己盯盘的加密货币 + 代币化美股观察台。页面在浏览器里直接向公开接口拉实时数据；提醒可以用 Telegram 推到手机。全程不需要付费 AI 会员。

**本页说明按「只有 iPhone、没有电脑」来写。** 若你后来有 Mac / Windows，文末有补充。

> 本工具只提供公开行情与提醒，不是投资建议。下单请在币安 App 里由你自己确认。

---

## 它能做什么

网页（做成 PWA，可添加到 iPhone 主屏幕）：

- 市场摘要：BTC、总市值、BTC 占比、恐慌贪婪指数、24h 成交
- 币安现货实时行情（主流币、涨跌榜），WebSocket 推送，断线自动重连，失败则回退 REST
- K 线（多周期）+ 当前周期主动买卖比，K 线会随推送更新
- 资金费率热力图、持仓量趋势、多空比、主动买卖比
- 爆仓流水（需币安期货 WebSocket；美国 IP 经常不可用，欧洲/亚洲通常可以）
- 放量扫描、自选与价格预警（保存在手机浏览器里）
- 代币化美股（xStocks）及与正股的溢价 / 30 日相关（正股需 Actions 写入）
- 宏观日历、加密相关资讯（Hacker News）
- 每个模块显示数据来源和更新时间；某个接口失败时，其它模块照常工作

后台监控（两种，可只选一种）：

1. **默认、完全免费：GitHub Actions 每约 10 分钟轮询一次**，命中阈值就发 Telegram。请注意：定时任务最短大约 5 分钟，**而且经常会延迟**，不是实时。
2. **真正实时：在非美国区域的云主机上跑 `monitor.py --realtime`**（推荐 Oracle Cloud Always Free，法兰克福 / 东京 / 新加坡）。从 iPhone 用浏览器里的 Cloud Shell 或 Termius 就能装。

---

## 零、先准备一个 Telegram 机器人（两种监控都要用）

全程在 iPhone 的 Telegram 和 Safari 里完成：

1. 打开 Telegram，搜索 **`@BotFather`**（官方，带蓝钩），发 `/newbot`，按提示起名。
2. BotFather 会给你一段 **token**（形如 `123456:ABC...`）。先复制保存到备忘录，**不要发给别人，也不要写进 GitHub 的普通文件里**。
3. 点开你刚创建的机器人，按 **Start / 开始**，随便发一句「你好」。
4. 用 Safari 打开下面这个地址（把 `TOKEN` 换成你的 token）：  
   `https://api.telegram.org/botTOKEN/getUpdates`
5. 在返回的 JSON 里找 `"chat":{"id":` 后面的数字，那就是 **chat id**（个人聊天一般是一串数字，有的以 `-` 开头）。同样只保存在备忘录里。

若 `getUpdates` 的 `result` 是空数组，再给机器人发一条消息后刷新该网址。

---

## 一、只用 iPhone：把观察台上到 GitHub Pages（推荐主路径）

这样你的手机浏览器随时能打开，并能「添加到主屏幕」，不经过任何 AI 服务。

### 1. 得到项目文件

把 `trading-dashboard.zip` 传到 iPhone（隔空投送、网盘、文件 App 均可），在「文件」里解压，得到 `trading-dashboard` 文件夹。

### 2. 新建 GitHub 仓库并上传

1. 用 **Safari** 打开 [https://github.com](https://github.com)，登录或注册。
2. 点右上角 **+ → New repository**。仓库名例如 `trading-dashboard`。选 **Public**（免费 Pages 对公开仓库最省事）。**不要**勾选 “Add a README”（本地已经有了）。创建。
3. 在仓库页点 **uploading an existing file** / **Add file → Upload files**。
4. 把解压后文件夹里的内容都选上（包含 `index.html`、`app.js`、`app.css`、`monitor.py`、`.github` 等）。若 iOS 一次选不全，可以分几次上传。  
   - 如果网页上传无法带上隐藏的 `.github` 文件夹：点 **Add file → Create new file**，文件名填  
     `.github/workflows/monitor.yml`  
     然后把压缩包里对应文件的内容粘贴进去。用同样方法再建  
     `.github/workflows/keepalive.yml` 和  
     `.github/workflows/refresh-public-data.yml`。
5. 点 **Commit changes**。

### 3. 打开 GitHub Pages

1. 仓库页 → **Settings → Pages**（手机上若看不到 Settings，先点仓库标题下的菜单，或把 Safari 请求桌面网站）。
2. **Build and deployment → Source** 选 **Deploy from a branch**。
3. Branch 选 `main`（或 `master`），文件夹选 `/ (root)`，保存。
4. 等 1–2 分钟，同一页会出现地址，形如：  
   `https://<你的用户名>.github.io/trading-dashboard/`
5. 用 **Safari** 打开这个地址（不要用微信 / 电报内置浏览器）。

### 4. 添加到 iPhone 主屏幕，并开启通知

1. 必须用 **Safari** 打开上述网址。
2. 点底部分享按钮（方框加向上箭头）→ **添加到主屏幕** → 添加。
3. 回到桌面，点「观察台」图标进入（这时才是 PWA）。
4. 打开「自选」页，点 **开启浏览器通知**，允许系统权限。  
   - 需要 **iOS 16.4 或更新**。  
   - iOS 的网页通知只对「已添加到主屏幕的 PWA」开放。  
   - **即使开了通知，也主要是观察台在前台时即时提醒。** 锁屏、切走 App 之后，请用下面的 Telegram 监控，不要指望网页在后台持续推送（本项目是静态网页，没有自己的推送服务器）。

自选列表和预警阈值保存在 Safari 本地。若清掉网站数据，它们会丢失，需要重新添加。

---

## 二、默认免费盯盘：GitHub Actions（约 10 分钟一轮，非实时）

适合：没有云主机、只想在价格突破 / 资金费极端 / 放量 / 即将公布的高影响宏观数据时，收到 Telegram。

**请先有心理预期：** GitHub 定时任务最短约 5 分钟，本仓库设为每 10 分钟。实际执行经常会晚几分钟到十几分钟，偶发更久，**不能当作实时盯盘**。

### 1. 把 Telegram 密钥存成 GitHub Secrets（不要写进 config.json）

1. 打开你的仓库 → **Settings → Secrets and variables → Actions**。
2. 新建两个 secret：  
   - `TELEGRAM_BOT_TOKEN`：机器人 token  
   - `TELEGRAM_CHAT_ID`：chat id
3. **Actions** 页如果提示 Enable workflows，点启用。

### 2. 改你关心的阈值

用 GitHub 网页编辑仓库根目录的 `config.json`（可以提交，里面没有密钥）：

- `symbols`：监控的交易对
- `price_alerts`：`above` / `below` 为突破价，不需要的项可删或把数字留空
- `funding_abs_threshold`：资金费率绝对值阈值（`0.0005` 表示 0.05%）
- `volume_spike_ratio`：5 分钟成交量相对中位数的倍数
- `cooldown_minutes`：同一类提醒的冷却时间，避免刷屏
- `calendar_impact`：要提醒的宏观影响级别，默认 `["High"]`

保存/提交后，下一次工作流就会用新阈值。

### 3. 第一次手动跑一下

仓库 → **Actions → Trading Monitor → Run workflow**。跑完后看日志，Telegram 里应能收到（若刚好没有触发条件，日志会写「本轮没有新的提醒」）。也可在电脑或以后用 `--dry-run` 先演练（见文末）。

另外两个工作流：

- **Refresh public data**（每 4 小时）：写入 `public-data/calendar.json` 和 `equities.json`，让网页能显示宏观日历、代币相对正股的溢价。请同样启用。可手动 Run 一次，立刻看到数据。
- **Keepalive**（每周一）：提交一个时间戳，避免仓库 60 天无活动后 GitHub 停掉定时任务。

若一段时间后定时不跑了：打开 Actions 看是否被禁用，点 Enable，并手动跑一次 Keepalive 或 Monitor。

---

## 三、真正实时的提醒：Oracle Cloud 免费云主机（仍可用 iPhone 完成）

当你需要「价格一碰到阈值立刻推 Telegram」时，用这个方案。GitHub Actions 可以保留作备份。

### 为什么不要选美国区域

币安主站 API 和部分 WebSocket（`api.binance.com`、`fapi.binance.com`、`stream.binance.com`、期货 `fstream.binance.com`）会封锁部分地区（尤其是美国 IP，常见 HTTP 451 或「连上但不推数据」）。GitHub 的跑腿机也在美国，所以 Actions 模式已经自动改走 `data-api.binance.vision`、`data-stream.binance.vision` 和 OKX 等仍开放的接口。

实时模式若要使用币安官方期货推送（资金费、爆仓），请把云主机建在 **非美国区域**，例如：

- 法兰克福 `eu-frankfurt-1`（欧洲，延迟通常较好）
- 东京 `ap-tokyo-1`、新加坡 `ap-singapore-1`

观察台网页本身已做自动降级：现货优先用 vision 备用域名（全球都比较稳）；期货推送能通则用，不能通则资金费/持仓量改走 OKX。

### 用 iPhone 注册并创建 Always Free 实例

1. Safari 打开 [Oracle Cloud Always Free](https://www.oracle.com/cloud/free/) 注册。需要信用卡验证，**请自行阅读甲骨文当前的免费条款与账单说明**。新账号有时会被风控拒绝，或某个区域没有空闲容量，这是甲骨文侧的限制，不是本软件的问题。
2. **注册时选的 Home Region 以后很难改**，请直接选法兰克福 / 东京 / 新加坡之一，不要选美国的 Ashburn / Phoenix。
3. 登录控制台 → **Compute → Instances → Create instance**。  
   - 镜像建议 **Ubuntu 22.04 或 24.04**。  
   - 形状选 Always Free 合格项（常见是 AMD Micro，或有容量时的 Ampere A1）。  
   - 生成 SSH 密钥，把私钥保存到「文件」App，并导入 [Termius](https://termius.com/)（可选）。
4. 实例变成 Running 后，记下公网 IP。不需要给安全组开放入站端口（监控只主动访问外网）。

### 一行安装（Cloud Shell 或 Termius）

**方法 A：控制台自带的 Cloud Shell（Safari 就能用）**

在 Oracle 控制台顶部打开 **Cloud Shell**，先 SSH 进实例（把密钥和 IP 换成你的）：

```bash
ssh -i <你的私钥文件> ubuntu@<公网IP>
```

若用户名不是 `ubuntu`（例如 `opc`），以控制台显示为准。

**方法 B：Termius 等 SSH App**  
导入私钥，主机填公网 IP，用户名 `ubuntu` 或 `opc`，连上即可。

登录后执行（把地址换成你的 GitHub 仓库）：

```bash
git clone https://github.com/<你的用户名>/trading-dashboard.git ~/trading-dashboard
sudo bash ~/trading-dashboard/install.sh
sudo nano /etc/trading-dashboard/env
```

在编辑器里填：

```
TELEGRAM_BOT_TOKEN=你的token
TELEGRAM_CHAT_ID=你的chatid
```

保存退出（nano：`Ctrl+O`、回车、`Ctrl+X`；在 iPhone 键盘上可能要按 `Ctrl` 键）。然后：

```bash
sudo systemctl restart trading-monitor
sudo systemctl status trading-monitor
```

看日志：

```bash
sudo journalctl -u trading-monitor -f
```

改阈值：`sudo nano /opt/trading-dashboard/config.json`，然后 `sudo systemctl restart trading-monitor`。  
若你在 GitHub 改了程序，到服务器上 `cd ~/trading-dashboard && git pull && sudo bash install.sh` 即可更新（已有 `config.json` 会被保留）。

`install.sh` 会把 `monitor.py --realtime` 注册为 systemd 服务，开机自启、崩溃后自动拉起。

---

## 四、若你有 Mac 或 Windows（可选）

没有云主机、又想本机实时跑时可以用。手机仍通过 GitHub Pages 看盘。

1. 安装 [Python 3](https://www.python.org/downloads/)（Windows 安装时勾选 Add to PATH）。
2. 解压本项目，在终端 / PowerShell 进入目录：

```bash
python3 -m venv .venv
# Windows: py -3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp config.example.json config.json  # Windows: copy config.example.json config.json
# 编辑 config.json 里的阈值
export TELEGRAM_BOT_TOKEN="..."    # Windows PowerShell: $env:TELEGRAM_BOT_TOKEN="..."
export TELEGRAM_CHAT_ID="..."
python monitor.py --dry-run        # 先演练，不发 Telegram
python monitor.py --realtime       # 实时守护
```

把窗口一直开着，或用系统「任务计划程序 / launchd」在登录时启动。密钥用环境变量，不要写进要上传的文件。

本地只预览网页时，不要直接双击 `index.html`（部分浏览器对本地文件限制较多）。在目录里运行：

```bash
python3 -m http.server 8080
```

再用浏览器打开 `http://127.0.0.1:8080/`。发布给手机用时，仍建议走 GitHub Pages。

---

## 数据来源与地区限制（请读）

| 用途 | 首选 | 美国 IP / GitHub 跑腿机 | 说明 |
| --- | --- | --- | --- |
| 现货行情、K 线 | 币安 REST / WS | 主站常返回 451，自动改用 `data-api.binance.vision`、`data-stream.binance.vision`（已测可用且允许跨域） | 数据同属币安公开行情 |
| 期货资金费、标记价、爆仓推送 | `fapi.binance.com` / `wss://fstream.binance.com` | REST 常 451；期货 WS 可能握手成功但不推送 | 实时爆仓依赖该推送，失败时页面会标明 |
| 资金费、持仓量、多空比、主动买卖 | 上面失败则用 **OKX 公开接口**（允许跨域） | 可用 | 热力图会标注来源 |
| 恐慌贪婪 | alternative.me | 可用，允许跨域 | |
| 总市值、BTC 占比、xStocks | CoinGecko | 可用，允许跨域；有频率限制 | 失败时该模块显示错误，不影响行情 |
| 宏观日历 | Forex Factory 公开 JSON | 服务器可拉，**浏览器没有 CORS** | 由 Actions 写入 `public-data/calendar.json` 同源读取 |
| 美股正股 | Yahoo Finance | 服务器可拉，**浏览器没有 CORS** | 由 Actions 写入 `public-data/equities.json` |
| 资讯 | Hacker News Algolia（加密相关） | 可用，允许跨域 | 不是专业财经资讯源；CryptoCompare 等已改为要密钥，故未接入 |

Bybit 公开接口在本次从美国 IP 测试中返回 403，未作为依赖。

若你人在被币安限制的地区，网页仍应能显示现货、OKX 衍生品和 CoinGecko 数据。要看期货爆仓流水，请换非美国网络或使用非美国 VPS 上的监控。

---

## 配置与文件说明

- `index.html` / `app.js` / `app.css`：观察台网页
- `manifest.webmanifest` / `sw.js` / `icons/`：PWA（可添加到主屏幕；离线只保留外壳，行情始终走网络）
- `monitor.py`：监控脚本  
  - 默认：轮询一次（Actions 用）  
  - `--dry-run`：只打印，不发 Telegram  
  - `--realtime`：WebSocket 常驻  
  - `--write-public`：刷新 `public-data/`
- `config.json` / `config.example.json`：阈值（无密钥）
- `install.sh`：在 Linux 上安装 systemd 实时服务
- `.github/workflows/`：Actions
- `requirements.txt`：`requests`、`websocket-client`

密钥来源优先级：环境变量 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`。不要把真实 token 提交到仓库。

---

## 常见问题

**页面打不开或一直「等待数据」**  
确认用 Safari 打开的是 `https://<用户名>.github.io/...`，等 Pages 部署完成。可下拉刷新。若只缺期货或正股，属于地区或 Actions 尚未运行，不是整个站点坏了。

**iPhone 没有通知**  
必须「添加到主屏幕」后再进 PWA 授权；系统需 iOS 16.4+。后台锁屏请用 Telegram。

**Actions 没发消息**  
检查 Secrets 名称是否完全一致、机器人是否已 Start、阈值是否合理、工作流是否被禁用。看 Actions 日志。可把某个 `below` 设得很高做一次测试，测完改回来。

**60 天后定时停了**  
跑一次 Keepalive 工作流，或在仓库里随便提交一次，再 Enable Actions。

**Oracle 实例创建失败**  
换一个有容量的非美国区域，或过几天再试。不要为了「有容量」改去美国区域，否则期货接口可能不可用。

**这是自动交易吗？**  
不是。本项目只观察与提醒，不会也不能替你下单。
