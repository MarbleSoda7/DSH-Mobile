# 部署现状（2026-10-29 实测）

> 记录「服务器上装了什么、电脑上跑的是什么、怎么自测的」。**不含任何密钥。**
>
> 早期几版这里写的是 frps / frpc / SSH 反向隧道 / Cloudflare 临时隧道的切换史，那些都已经废弃并删除，本文件只保留当前形态。

## 一句话

服务器 `8.152.5.127` 跑 `dsh-gateway`（端口分配 + 隧道服务）+ Caddy；电脑上装着插件，插件自己发起隧道。手机扫一次码即可接管，**不需要 frpc、不需要 SSH、不需要 cloudflared**。

## 服务器 8.152.5.127（Ubuntu 22.04 · 2 核 / 1.7G / 40G）

| 项目 | 值 |
| --- | --- |
| 公网端口 | `7789`（服务） + `9000-9099`（用户电脑入口） |
| `dsh-gateway.service` | `/opt/dsh-gateway/{api.py,tunnel.py}`，Python 标准库，无 pip 依赖 |
| 监听 | 分配接口 `127.0.0.1:7790`，隧道服务 `127.0.0.1:7791`——都只回环 |
| 台账 | `/var/lib/dsh-gateway/api.json`（`machines` + `routes` 两份映射） |
| 端口池 | `9000` 起，步长 1，100 个槽，上限 `9099` |
| 回收 | `DSH_API_RECLAIM_IDLE=604800`（7 天不露面才回收） |
| Caddy | `/etc/caddy/Caddyfile`；`admin off`，**改完必须 `systemctl restart caddy`**（reload 会失败） |
| 已删除 | `frps`（`systemctl disable` + `pkill`）、`/etc/frp/`、Cloudflare 隧道脚本、SSH 反向隧道脚本、仓库里的共享部署密钥 |

对外只有 `7789` 一个口，按路径分流：`/api/*` → 7790，`/tunnel*` → 7791，其余 404。

## 电脑（Windows）

| 项目 | 值 |
| --- | --- |
| 插件监听 | `0.0.0.0:7788`（手机同 WiFi 可直连；隧道目标也是它） |
| 状态目录 | `%USERPROFILE%\.dsh\dsh-mobile-remote\`：`identity.json` / `devices.json` / `usage.json` / `plugin.log` |
| 隧道 | 插件内部（`lib/tunnel.js`），纯 Node WebSocket，**无可执行文件** |
| 身份 | 首次启动向 `/api/claim` 报到拿 `deviceId`/`secret`/`token`/`port`，之后续约，端口不变 |
| 自愈 | 断线指数退避重连；服务器不认 token 时自动重领；`lastState`/`lastError` 如实落盘 |

## 当前生效版本

```
GET http://127.0.0.1:7788/api/health
→ {"ok":true,"rev":"r2026-10-29-selfheal63",...}
```

`rev` 是判断「运行的是哪份代码」的唯一依据。桌面版宿主会把 `console` 收走，排查一律看 `%USERPROFILE%\.dsh\dsh-mobile-remote\plugin.log`。

## 端到端自测（不需要手机）

```bash
node tools/test-tunnel.mjs      # 内置隧道：起本机假服务，跑完 open/data/close
node tools/smoke.mjs            # 协议层：假 ctx 驱动插件，38+ 项
node tools/timeline-probe.mjs   # 前端：假 DOM 跑 web/app.js，20+ 项
```

三个都不联网、不需要真实 DSH。线上验证走公网：

```bash
curl --noproxy '*' -s http://8.152.5.127:9000/api/health
```

`Invoke-WebRequest` 会吃到系统代理，测公网必须用 `curl.exe --noproxy '*'`。

## 历史坑（都已修，留作对照）

| 症状 | 根因 |
| --- | --- |
| 公网 9xxx 一律 `400 Bad Request` | 隧道把 Upgrade 响应后跟的 `head` 字节当裸字节写给了本机 TCP |
| 手机连上立刻 `ECONNRESET` | 服务端两个线程都 `close()` 同一个 socket，内核发 RST |
| 两台电脑互相顶掉 | frp 时代所有客户端代理名都叫 `dsh-mobile`；现在端口由 `deviceId` 绑定 |
| 台账重置后插件永久 403 | token 被判废时不会重新 claim；现已自愈 |
| `identity.json` 写着 ok 其实断着 | 状态在握手前就落盘了；现在只有收到 `ready` 才写 `ok` |
