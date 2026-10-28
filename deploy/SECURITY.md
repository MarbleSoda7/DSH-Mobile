# 服务端安全说明

这是「DSH Mobile Remote」服务端（`8.152.5.127`）的部署与安全边界说明。

## 先明确一件事：没有 SSH 了

早期版本用 SSH 反向隧道，那时候**仓库里公开着一把共享 ed25519 部署密钥**——谁 clone 到这个仓库，谁就能拿它连服务器。那是个严重的问题，已经彻底删掉了：

- 仓库里的 `deploy/pc/*_ed25519` 已删除
- 服务器 `/root/.ssh/authorized_keys` 里对应的行已删除
- 客户端不再执行任何 `ssh`，改成纯 Node 的 WebSocket 隧道（`lib/tunnel.js`）

**现在插件里没有一个可执行文件，也没有一把共享密钥。** 下面讲的是当前实际架构。

## 当前架构

```
手机 ──> 8.152.5.127:9000-9099 ──┐
                                 ├─> 服务器 TunnelServer（127.0.0.1:7791）
插件 ──> 8.152.5.127:7789 ───────┘         │
   └─ /api/*    → 127.0.0.1:7790（分配接口）│
   └─ /tunnel   → 127.0.0.1:7791（隧道服务）│
                                            ▼
                                    你的电脑 127.0.0.1:7788
```

服务器对公网只开 **两个** 端口段：

| 端口 | 用途 | 谁能连 |
| --- | --- | --- |
| `7789` | 分配接口 + 隧道控制通道 | 公网 |
| `9000`–`9099` | 用户电脑的对外入口 | 公网 |

`7790` / `7791` 只监听 `127.0.0.1`，公网连不到。

## 认证模型

### 端口分配（`/api/claim`）

第一次报到不带 `deviceId`，服务器发一套新的：

```json
{"deviceId": "dev_...", "secret": "...", "token": "...", "port": 9000}
```

之后每次都带 `deviceId + secret` 来续约。`secret` 存在客户端 `<stateDir>/identity.json` 里，服务器侧存明文（本地台账，不是公网服务）。

### 隧道握手（`/tunnel`）

控制通道建好后客户端发 `{"t":"hello","token":...,"port":...}`，服务器校验 `token → port` 映射，不匹配直接回 `{"t":"error","msg":"token 无权占用端口 X"}` 并断开。

**这里不做「服务器发起连接」**，所以拿到 token 的人只能占用自己那个端口，开不出别人的。

### 手机侧

设备令牌 = `<id>.<32 字节 hex>`，服务端只存 `sha256`。配对码只能从回环地址生成、2 分钟有效、一次即焚。

## 部署步骤

```bash
# 1. 上传服务端文件
scp deploy/vps/{api.py,tunnel.py,Caddyfile,dsh-gateway.service} root@服务器:/opt/dsh-gateway/
scp deploy/vps/Caddyfile root@服务器:/etc/caddy/Caddyfile
scp deploy/vps/dsh-gateway.service root@服务器:/etc/systemd/system/

# 2. 装依赖（只用 Python 标准库）
apt install -y python3 caddy

# 3. 起服务
mkdir -p /var/lib/dsh-gateway
echo '{"machines":[],"routes":{}}' > /var/lib/dsh-gateway/api.json
systemctl daemon-reload
systemctl enable --now dsh-gateway
systemctl restart caddy
```

### 云安全组

必须放行：

- `7789` —— 分配接口 + 隧道控制
- `9000-9099` —— 用户入口（**端口段写法**，不要一条条列单端口）

### 端口池配置

`dsh-gateway.service` 里的环境变量：

```ini
Environment=DSH_API_PORT_BASE=9000
Environment=DSH_API_PORT_STEP=1
Environment=DSH_API_SLOTS=100
Environment=DSH_API_PUBLIC_PORT_MAX=9099
Environment=DSH_API_RECLAIM_IDLE=604800
```

`PORT_BASE + (SLOTS-1)*STEP` 超过 `PUBLIC_PORT_MAX` 时**服务直接启动失败**——这是故意的，防止发出一个安全组根本没开的端口，让接进来的机器永远连不上。

`DSH_API_RECLAIM_IDLE` 是端口回收线（秒），默认 7 天。

## 威胁模型

| 攻击者想干什么 | 能不能做到 |
| --- | --- |
| 用别人的地址访问别人的电脑 | 不能。每个端口只对持有对应 token 的控制通道开放 |
| 拿到 root shell | 不能。没有 SSH，只有隧道协议 |
| 扫端口发现 DSH | 不能。未带设备 cookie 的 `/` 返回 404 |
| 抢别人的端口 | 不能。端口跟 `deviceId` 绑定，7 天不露面才回收 |
| 伪造 `deviceId` 抢端口 | 不能。要同时有 `secret` |
| **服务端维护者**看你的流量 | **能**。隧道是明文 WebSocket，中间人可见 |

最后一条说清楚：这套东西**不提供端到端加密**。HTTP 明文在服务器上可以被抓包。它解决的问题是「在外面也能用手机接管 DSH」，不是「防止服务器看你」。

## 已知风险

1. **单点**。服务器挂了，所有手机的二维码地址都失效。插件自己是好的，但公网入口没了。
2. **明文**。见上。
3. **台账手工维护的风险**。`/var/lib/dsh-gateway/api.json` 被重置之后，所有已安装机器会在下次重连时自动重新 claim 新身份，端口可能变——手机上旧二维码要重新扫。客户端会自愈，但用户需要知道这件事。
4. **没有速率限制**。`/api/claim` 可以被刷，池子会被占满。目前靠池子大小（100）挡着。
