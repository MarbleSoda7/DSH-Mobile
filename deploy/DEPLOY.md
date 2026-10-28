# 服务端部署：8.152.5.127

一句话链路：**手机 → 服务器 9xxx → Caddy(7789 /tunnel) → TunnelServer → 你的电脑 7788 → 插件 → DSH**。

```
手机 (PWA)                  云服务器 8.152.5.127                       你的电脑
   │ http://8.152.5.127:9001       │                                      │
   └──────────────────────► TunnelServer 127.0.0.1:7791 ◄──────────────── 出站 WebSocket
                                    ▲  控制口 7789 /tunnel                 （插件自己发起）
                                    │
      插件 ──► 7789 /api/claim ─→ 127.0.0.1:7790（端口分配）
```

方向很重要：**电脑主动连服务器**，服务器从不发起连接。所以电脑在 NAT / 公司网 / 酒店网都能用，只要它开着。电脑关机期间手机连不上——这是已知边界，不是 bug。

服务器对公网只开 **7789**（服务）和 **9000–9099**（用户电脑入口）。`7790` / `7791` 只监听回环。

---

## 1. 服务器装依赖

```bash
apt install -y python3 caddy
```

服务端只用 Python 标准库，没有 pip 依赖。

## 2. 上传文件

```bash
mkdir -p /opt/dsh-gateway /var/lib/dsh-gateway

scp deploy/vps/api.py deploy/vps/tunnel.py           root@8.152.5.127:/opt/dsh-gateway/
scp deploy/vps/Caddyfile                             root@8.152.5.127:/etc/caddy/Caddyfile
scp deploy/vps/dsh-gateway.service                   root@8.152.5.127:/etc/systemd/system/
```

## 3. 初始化台账并启动

```bash
ssh root@8.152.5.127

echo '{"machines":[],"routes":{}}' > /var/lib/dsh-gateway/api.json

systemctl daemon-reload
systemctl enable --now dsh-gateway
systemctl restart caddy      # admin off 时 reload 会失败，必须 restart
```

`dsh-gateway.service` 里的关键环境变量：

```ini
Environment=DSH_API_HOST=127.0.0.1
Environment=DSH_API_PORT=7790          # 分配接口
Environment=DSH_TUNNEL_PORT=7791       # 隧道服务
Environment=DSH_API_PORT_BASE=9000     # 端口池起点
Environment=DSH_API_PORT_STEP=1
Environment=DSH_API_SLOTS=100          # 池子大小
Environment=DSH_API_PUBLIC_PORT_MAX=9099
Environment=DSH_API_RECLAIM_IDLE=604800  # 7 天不露面回收
Environment=DSH_API_PUBLIC_HOST=8.152.5.127
Environment=DSH_API_STATE=/var/lib/dsh-gateway/api.json
```

`PORT_BASE + (SLOTS-1)*STEP` 超过 `PUBLIC_PORT_MAX` 时服务**直接启动失败**——故意的，防止发出一个安全组没开放的端口。

## 4. 安全组放行

阿里云控制台 → 安全组 → 入方向，加两条：

| 端口 | 用途 |
| --- | --- |
| TCP `7789` | 端口分配接口 + 隧道控制通道 |
| TCP `9000-9099` | 用户电脑的对外入口（**用端口段写法**，别一条条列） |

安全组没放行的话，下面所有验证都会「看起来装好了但连不上」——这是第一排查项。

## 5. Caddyfile

```caddyfile
:7789 {
	handle /tunnel* {
		reverse_proxy 127.0.0.1:7791 {
			flush_interval -1
			read_timeout 0
			write_timeout 0
		}
	}
	handle /api/* {
		reverse_proxy 127.0.0.1:7790
	}
	respond 404
}
```

必须留 `flush_interval -1` 和两个 `0` 超时：隧道是长连接 WebSocket，缓冲或超时会把它掐断。

## 6. 验证

```bash
# 分配接口活着
curl -s http://127.0.0.1:7789/api/health

# 隧道服务活着（应返回 HTTP 400，说明它只接 Upgrade 请求）
curl -si http://127.0.0.1:7789/tunnel | head -3
```

电脑侧：重启 DSH，然后打开 `http://127.0.0.1:7788/api/identity`，`state` 应为 `ok`，`port` 是分到的端口。

之后从公网打：

```bash
curl -s http://8.152.5.127:9000/api/health    # 期望 {"ok":true,...}
```

看到 200 就说明整条链路通了。

## 7. 不用域名 / 不加 TLS

现在这套是**明文 HTTP**，没有域名、没有证书。代价：

- 手机的 Service Worker 不注册 → 完全断网时打不开、装不成独立 App
- 链路上服务器能看到流量内容

要上 TLS，需要备案域名 + Caddy 自动签证书，把 `:7789` 换成域名、9xxx 那一段改成 Caddy 按 `Host` 分流。没做这件事之前，请把这套当成「内网级别信任」的工具。

## 8. 排障

| 现象 | 原因 → 处理 |
| --- | --- |
| 手机打不开，公网 9xxx 直接 connection refused | 该端口上没隧道。看电脑 `/api/identity` 的 `state`，再看 `<stateDir>/plugin.log` |
| 公网 9xxx 返回 400 | 隧道把 Upgrade 握手和首帧搞混了（旧版本 bug），更新插件 |
| `/api/claim` 502 | Caddy 没起或 api.py 没跑：`systemctl status dsh-gateway caddy` |
| 手机提示「配对码无效/过期」 | 别用别人的二维码。每台电脑的码只对自己那个端口有效 |
| 消息要等整条生成完才出现 | 反代缓冲：确认 Caddy 的 `flush_interval -1` 没被删掉 |
| 端口被拒绝但安全组开了 | 服务器只对**已分配**的端口起监听，空槽位本来就连不上 |
| 重启后端口变了 | 台账被重置了；机器会重新 claim 一个新身份，手机上要重扫 |

### 彻底重置一台机器

```bash
systemctl stop dsh-gateway
python3 - <<'EOF'
import json
p='/var/lib/dsh-gateway/api.json'
d=json.load(open(p))
d['machines']=[m for m in d['machines'] if m['deviceId']!='dev_要删的ID']
d['routes']={k:v for k,v in d['routes'].items() if v.get('deviceId')!='dev_要删的ID'}
json.dump(d,open(p,'w'))
EOF
systemctl start dsh-gateway
```

**不要手改 `machines[].port` 而不改 `routes`**——`verify_token` 要求两边一致，否则插件会报「token 无权占用端口 X」。要么两边一起改，要么直接删掉让插件重新领。
