#!/usr/bin/env bash
# 在公网服务器上安装 DSH Mobile 网关（80 端口，按 token 路由到各台电脑）
#
# 用法（在服务器上以 root 执行）：
#   bash setup-gateway.sh
#
# 做的事：
#   1. 把 dsh-gateway.py 放到 /opt/dsh-gateway/
#   2. 注册并启动 systemd 服务 dsh-gateway（开机自启、崩溃自动重启）
#   3. 打印监听状态
#
# 为什么用 Python：服务器上已经有 python3，而 nginx/node 都没装；这个网关只用标准库，
# 不需要 pip install 任何东西，重装系统也不会因为依赖缺失而起不来。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR=/opt/dsh-gateway
STATE_DIR=/var/lib/dsh-gateway

install -d "$TARGET_DIR" "$STATE_DIR"
install -m 0755 "$HERE/dsh-gateway.py" "$TARGET_DIR/dsh-gateway.py"

cat >/etc/systemd/system/dsh-gateway.service <<'UNIT'
[Unit]
Description=DSH Mobile gateway (port 80, token routed)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/dsh-gateway/dsh-gateway.py
Environment=DSH_GW_PORT=80
Environment=DSH_GW_STATE=/var/lib/dsh-gateway/state.json
Restart=always
RestartSec=3
StandardOutput=append:/var/log/dsh-gateway.log
StandardError=append:/var/log/dsh-gateway.log

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable dsh-gateway >/dev/null
systemctl restart dsh-gateway
sleep 2

echo "=== status ==="
systemctl is-active dsh-gateway || true
ss -lntp | grep -E ':80 ' || echo "port 80 NOT listening"
echo "=== health ==="
curl -s -m 5 http://127.0.0.1/__dsh_gateway_health || echo "(health failed)"
echo
echo "=== done. 日志：/var/log/dsh-gateway.log ==="
