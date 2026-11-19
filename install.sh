#!/usr/bin/env bash
# 在非美国区域的 Linux（推荐 Oracle Cloud Always Free：法兰克福 / 东京 / 新加坡）
# 安装交易观察台实时监控，并注册为 systemd 服务。
# 用法：
#   git clone https://github.com/<你的用户名>/<仓库>.git ~/trading-dashboard
#   sudo bash ~/trading-dashboard/install.sh
# 或已在仓库目录内： sudo bash install.sh
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "请用 root 运行： sudo bash install.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/trading-dashboard}"
ENV_FILE="${ENV_FILE:-/etc/trading-dashboard/env}"
SERVICE_NAME="trading-monitor"

echo "==> 安装系统依赖"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y python3 python3-venv python3-pip git ca-certificates
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y python3 python3-pip git ca-certificates
elif command -v yum >/dev/null 2>&1; then
  yum install -y python3 python3-pip git ca-certificates
else
  echo "无法识别的包管理器，请先手动安装 python3、python3-venv、pip、git"
  exit 1
fi

echo "==> 复制程序到 ${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"
# 不覆盖已有 config.json / 状态文件
if [[ "${SCRIPT_DIR}" != "${INSTALL_DIR}" ]]; then
  TMPCFG=""
  if [[ -f "${INSTALL_DIR}/config.json" ]]; then
    TMPCFG="$(mktemp)"
    cp -a "${INSTALL_DIR}/config.json" "$TMPCFG"
  fi
  find "${SCRIPT_DIR}" -mindepth 1 -maxdepth 1 ! -name '.venv' ! -name '.monitor-state.json' ! -name '.git'     -exec cp -a {} "${INSTALL_DIR}/" \;
  if [[ -n "$TMPCFG" ]]; then
    cp -a "$TMPCFG" "${INSTALL_DIR}/config.json"
    rm -f "$TMPCFG"
  fi
fi
cd "${INSTALL_DIR}"

if [[ ! -f config.json ]]; then
  cp config.example.json config.json
fi

echo "==> 创建 Python 虚拟环境并安装依赖"
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

echo "==> 准备环境变量文件 ${ENV_FILE}（Telegram 密钥，不要提交到 Git）"
mkdir -p "$(dirname "${ENV_FILE}")"
if [[ ! -f "${ENV_FILE}" ]]; then
  cat > "${ENV_FILE}" << 'ENV'
# 在 Telegram 找 @BotFather 创建机器人后填入：
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ENV
  chmod 600 "${ENV_FILE}"
  echo "已创建 ${ENV_FILE}，请编辑填入 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID"
else
  echo "已存在 ${ENV_FILE}，保持不变"
fi

echo "==> 写入 systemd 服务 ${SERVICE_NAME}.service"
cat > /etc/systemd/system/${SERVICE_NAME}.service << UNIT
[Unit]
Description=Trading dashboard realtime monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=-${ENV_FILE}
ExecStart=${INSTALL_DIR}/.venv/bin/python ${INSTALL_DIR}/monitor.py --realtime --config ${INSTALL_DIR}/config.json --state ${INSTALL_DIR}/.monitor-state.json
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"

echo
echo "安装完成。"
echo "  查看状态：  systemctl status ${SERVICE_NAME}"
echo "  查看日志：  journalctl -u ${SERVICE_NAME} -f"
echo "  填密钥：    nano ${ENV_FILE}   然后  systemctl restart ${SERVICE_NAME}"
echo "  改阈值：    nano ${INSTALL_DIR}/config.json  然后  systemctl restart ${SERVICE_NAME}"
echo "若 Telegram 还未配置，服务仍会运行，但只会把提醒打到日志里。"
