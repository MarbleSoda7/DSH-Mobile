#!/usr/bin/env bash
# 在云服务器上装 frps（幂等，可重复执行）。
#   sudo FRP_TOKEN=<和电脑端一致的长随机串> bash setup-frps.sh
# 不传 FRP_TOKEN 时自动生成一个，最后打印出来，复制到电脑端 frpc.toml。
set -euo pipefail

FRP_VERSION="${FRP_VERSION:-0.62.1}"
FRP_DIR=/etc/frp
BIN=/usr/local/bin/frps

log() { printf '\033[36m[frps]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[frps] %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 或 sudo 运行"

case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "不支持的架构: $(uname -m)" ;;
esac

TOKEN="${FRP_TOKEN:-$(tr -dc 'a-f0-9' </dev/urandom | head -c 48)}"
DASH_PW="${FRP_DASH_PW:-$(tr -dc 'a-zA-Z0-9' </dev/urandom | head -c 20)}"

need=()
command -v curl >/dev/null 2>&1 || need+=(curl)
command -v tar >/dev/null 2>&1 || need+=(tar)
if ((${#need[@]})); then
  log "安装依赖: ${need[*]}"
  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y "${need[@]}" >/dev/null
  elif command -v dnf >/dev/null 2>&1; then dnf install -y "${need[@]}" >/dev/null
  elif command -v yum >/dev/null 2>&1; then yum install -y "${need[@]}" >/dev/null
  else die "缺少 ${need[*]}，请先手动安装"; fi
fi

if [[ -x "$BIN" ]] && "$BIN" --version 2>/dev/null | grep -q "$FRP_VERSION"; then
  log "frps $FRP_VERSION 已存在，跳过下载"
else
  TARBALL="frp_${FRP_VERSION}_linux_${ARCH}.tar.gz"
  TMP="$(mktemp -d)"
  urls=(
    "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${TARBALL}"
    "https://ghfast.top/https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${TARBALL}"
    "https://gh-proxy.com/https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${TARBALL}"
  )
  ok=0
  for u in "${urls[@]}"; do
    log "下载 $u"
    if curl -fL --retry 3 --connect-timeout 10 -o "$TMP/frp.tgz" "$u"; then ok=1; break; fi
  done
  [[ $ok -eq 1 ]] || die "下载失败：请手动把 ${TARBALL} 传到服务器，解压后把 frps 放到 $BIN"
  tar -xzf "$TMP/frp.tgz" -C "$TMP"
  install -m 0755 "$TMP/frp_${FRP_VERSION}_linux_${ARCH}/frps" "$BIN"
  rm -rf "$TMP"
  log "已安装 $($BIN --version)"
fi

mkdir -p "$FRP_DIR" /var/log/frp
if [[ -f "$FRP_DIR/frps.toml" ]]; then
  log "保留已有 $FRP_DIR/frps.toml（如需重建请先备份删除）"
  EXISTING_TOKEN="$(grep -E '^\s*auth\.token' "$FRP_DIR/frps.toml" | head -1 | cut -d'"' -f2 || true)"
  [[ -n "${EXISTING_TOKEN:-}" ]] && TOKEN="$EXISTING_TOKEN"
else
  SRC="$(dirname "$0")/frps.toml"
  [[ -f "$SRC" ]] || SRC=/dev/stdin
  sed -e "s/REPLACE_WITH_LONG_RANDOM_TOKEN/${TOKEN}/" \
      -e "s/REPLACE_WITH_DASHBOARD_PASSWORD/${DASH_PW}/" "$SRC" >"$FRP_DIR/frps.toml"
  chmod 600 "$FRP_DIR/frps.toml"
  log "已写入 $FRP_DIR/frps.toml"
fi

cat >/etc/systemd/system/frps.service <<'UNIT'
[Unit]
Description=frp server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable frps >/dev/null 2>&1 || true
systemctl restart frps
sleep 1

if systemctl is-active --quiet frps; then
  log "frps 已运行 ✅"
else
  journalctl -u frps -n 30 --no-pager || true
  die "frps 启动失败"
fi

cat <<EOF

────────────────────────────────────────────
 服务器端就绪。把下面三项填进电脑端的 frpc.toml：

 serverAddr = "8.152.5.127"
 serverPort = 7000
 auth.token = "${TOKEN}"

 仪表盘口令（仅本机可看）: ${DASH_PW}

 还差两步（在阿里云控制台/本机操作）：
 1) 安全组放行 TCP 7000（frp 控制口）和 80/443（Caddy 证书与 HTTPS）
 2) 本机执行 deploy/pc/setup-frpc.ps1 -Token "<上面的 token>"
────────────────────────────────────────────
EOF
