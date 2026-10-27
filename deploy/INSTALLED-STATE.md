# 部署现状（2026-10-27 02:40 实测）

> 这份文件记录"已经装好什么、还差什么"，方便以后重装或排障。**含密钥，别外传。**

## 2026-10-27 17:3x 追记：手机端上滑翻页修好（rev `r2026-10-27-paging15`）

用户反馈「手机端上滑无法获取早期记录」。排查结论：服务端 `GET /api/session/:id/page` 一直支持 `before` 分页（`lib/index.js:1357` 起，`limit` clamp 1..20），问题在客户端 —— 源码事故恢复后 `web/app.js` 里 `loadOlder()` 整段丢失，滚动监听只切"回到底部"按钮。

| 改动 | 位置 | 说明 |
|---|---|---|
| 新增 `loadOlder()` | `web/app.js:874` | 取 `Math.min(...正 seq)` 作 `before`，`limit=OLDER_PAGE`，只收 `seq < oldest` 的新事件并 `saveEvent` |
| 新增 `prependOlder()` | `web/app.js:929` | 只把新页插到顶部，**不整表 reflow**（上千条时手机上会明显卡） |
| 新增 `noteOlderDone()` | `web/app.js:945` | 翻到头画一次「— 已经是全部记录了 —」 |
| 滚动门闩 `olderArmed` | `web/app.js` scroll 监听 | 一次滑动只翻一页；必须滚离顶部 >240px 才重新上闩；若加载后仍撑不满一屏则继续允许加载 |
| 加载提示 `.older-loading` | `web/style.css` | 顶部一行"正在加载更早的记录…"，插内容前先摘掉 |
| 每页条数 | `const OLDER_PAGE = 1` | 实测 `limit=1` → 2 条 3.1KB；`limit=2` → 5 条 6.7KB |

验收（真实会话 `session-fa9115…`）：
- `tools/timeline-probe.mjs` **20 passed**（T11 翻页 / T12 门闩 / T13 到底）
- `tools/paging-live.mjs` **9 passed**（含"存在会话能真正翻到开头 hasMore=false"）
- `tools/scroll-to-start.mjs`：`rounds=137 events=5282 unique=5282 oldest=0 hasMore=false` —— 1 万多条的长会话能一路翻到最老一条，0 重复
- `tools/smoke.mjs` **38 passed**；线上 `/api/health` = `rev r2026-10-27-paging15`；外壳引用 `app.js?v=r2026-10-27-paging15`（缓存穿透）；SW `dsh-mobile-shell-v5`

## 2026-10-27 03:5x 追记：插件已重写并在线（rev `r2026-10-27-prompt-signal3`）

`lib/index.js` 因编码事故被整份重写（约 1550 行），现在宿主里跑的是 `GET /api/health` 里 `rev` 对应的版本。两个真 bug 已修：

| 症状 | 根因 | 修法 |
|---|---|---|
| 手机发送消息返回 500 `Cannot read properties of undefined (reading 'throwIfAborted')` | `sessionController.prompt(request, signal)` 的 `signal` 必填（函数体第 2 行就 `signal.throwIfAborted()`），原先没传 | `/api/prompt`、`/api/redirect` 统一走 `withSignal()`（20s 超时 + AbortController） |
| 历史分页大面积 500 / 空 | `page()` 同样要求 `signal`；且 `throughSeq` 必须是真实日志 cursor（`projections().asOfSeq` 既不是 tail 也不是 cursor） | 从 `follow()` 的首帧 `snapshot` 取 `cursor` + 尾部一页，`page()` 再按 `cursor/beforeSeq` 往前翻 |

实测：新会话起一轮 → 立刻发第二条（`mode:'queue'`）→ `GET /api/queue` 返回 1 条、会话 `running:true`；`tools/smoke.mjs` 36/36 通过。

## 一句话状态

服务器和电脑两端都装好并自启了；**只剩阿里云安全组没放行**，放行后手机即可访问。

## 服务器 8.152.5.127（Ubuntu 22.04.5 LTS，2 核 / 1.7G / 40G）

| 项目 | 状态 |
|---|---|
| frps | 已装 `/usr/local/bin/frps` 0.62.1，`systemctl is-enabled/enabled` = enabled/active |
| 配置 | `/etc/frp/frps.toml`（bindPort 7000，allowPorts 只放 7788，仪表盘仅 127.0.0.1:7500） |
| 日志 | `/var/log/frp/frps.log` |
| 防火墙 | ufw inactive、iptables ACCEPT —— 服务器本机没有拦任何端口 |
| 登录方式 | **密钥**：`ssh -i C:\Users\29113\.ssh\dsh_vps_ed25519 root@8.152.5.127`（密码登录仍可用） |
| 部署脚本 | `/root/dsh-deploy/{setup-frps.sh,frps.toml,Caddyfile}` |

**frp token**（两端必须一致；仓库里不留明文）：
```
<已打码 —— 真实值见服务器 /etc/frp/frps.toml 的 auth.token，
 以及本机 %LOCALAPPDATA%\frp\frpc.toml 的 auth.token>
```
**frps 仪表盘**（`ssh -L 7500:127.0.0.1:7500 root@8.152.5.127` 后开 http://127.0.0.1:7500）：`admin` / 口令见服务器 `/etc/frp/frps.toml` 的 `webServer.password`

## 本机（Windows）

| 项目 | 状态 |
|---|---|
| frpc | 已装 `%LOCALAPPDATA%\frp\frpc.exe` 0.62.1（**目前不用它**，见下方 SSH 反向隧道） |
| 配置 | `%LOCALAPPDATA%\frp\frpc.toml`（ASCII-only，`loginFailExit = false` 防止连不上就退出） |
| 自启 | 计划任务 `dsh-frpc`（登录时启动，State=Ready）+ 失败自动重启 |
| 日志 | `%LOCALAPPDATA%\frp\frpc.log` |
| SSH 密钥 | `C:\Users\29113\.ssh\dsh_vps_ed25519`（专用，`-C dsh-mobile-vps`） |
| **SSH 反向隧道**（推荐） | `tools\dsh-vps-tunnel.ps1`，自启快捷方式 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dsh-vps-tunnel.lnk`；日志 `%LOCALAPPDATA%\dsh-vps-tunnel.log` |

## 用 IP 直接访问：SSH 反向隧道（2026-10-27 17:4x 配置完成）

用户要求"能不能用 IP 地址访问"。Cloudflare 临时隧道给的是域名且每次重启都变，所以改走服务器 IP：

```
手机 -> http://8.152.5.127:7788 -> VPS sshd(0.0.0.0:7788) -> PC 127.0.0.1:7788
```

- 服务器侧已做：`echo 'GatewayPorts clientspecified' >> /etc/ssh/sshd_config` + `systemctl reload ssh`，`sshd -T | grep gatewayports` = `clientspecified`。
- 本机侧已做：`tools\dsh-vps-tunnel.ps1` 用 `-R 0.0.0.0:7788:127.0.0.1:7788` 起反向隧道，并在启动文件夹注册自启；进程退出会自动重启（监督循环 20s）。
- 实测（服务器上）：`ss -lntp | grep 7788` → `LISTEN 0.0.0.0:7788 users:(("sshd"...))`；`curl http://127.0.0.1:7788/api/health` → **200**。
- **仍缺席的一步**：阿里云安全组放行入方向 **TCP 7788**（授权对象 `0.0.0.0/0`）。从公网扫 `8.152.5.127:7788` 仍是 closed —— 服务器本机已监听，纯粹被云侧挡掉。放行后无需任何其它改动，手机直接开 `http://8.152.5.127:7788` 即可。
- 好处：只需要**一条**入方向规则（不用再开 7000），也不用装额外客户端；frp 那套保留作为备选。
- 明文 HTTP 的代价（已向用户说明）：Service Worker 不注册 → 断网打不开（在线时普通缓存仍生效）；浏览器不弹"安装应用"，只能"添加到主屏幕"。

### 2026-10-27 17:5x 追记：安全组已放行，IP 直连打通 ✅

用户已在阿里云控制台加规则（`授权策略=允许 / 优先级=1 / 协议=自定义 TCP / 端口=7788/7788 / 来源=0.0.0.0/0`），实测：

| 检查 | 结果 |
|---|---|
| `8.152.5.127:7788` TCP | **OPEN** |
| `GET http://8.152.5.127:7788/api/health` | `{"ok":true,"rev":"r2026-10-27-paging15","devices":5,...}` |
| `tools/public-ip-check.mjs` | **12 passed, 0 failed** |
| `tools/paging-live.mjs`（`MR_BASE` 指向公网） | **9 passed, 0 failed**（1605 条事件一路翻页无重复） |
| 公网 `/admin`、`/api/paircode` | **403**（配对只能在电脑本机做） |
| 公网 `/api/attachment/<hash>` 未认证 | **401** |
| 公网 SSE | 收到 `event: hello`（明文直连**没有** Cloudflare 的分片缓冲问题） |
| 公网长轮询 | 挂起 25.0 秒正常返回 |

配套改动：
- `lib/index.js` 的 `/api/paircode` 地址优先级改为 **显式 origin > `publicOrigin` > `tunnelUrlFile` > 局域网**（原来隧道排在固定 IP 前面，二维码会一直指向会变的 trycloudflare 域名）。现在 `/api/paircode` 返回 `http://8.152.5.127:7788/?t=…`。
- `web/admin.html` 的「对外地址」输入框占位改为「留空＝自动（固定公网 IP 优先）」。

**手机端入口（以后固定就是这个）**：`http://8.152.5.127:7788`（电脑本机开 `http://127.0.0.1:7788/admin` 扫码配对）。

## 已验证过的链路（02:37）

因为安全组还没开，用 SSH 本地转发临时把 7000 打通做了端到端验证：

```
frpc(登录 8.152.5.127:7000 成功, proxy dsh-mobile 注册成功)
   → 服务器回环 curl http://127.0.0.1:7788/api/health
   → {"ok":true,...}   ✅
   → curl /admin → 200  ✅
```

证明：frps 配置、token、TLS、代理端口、插件监听全部正确，**唯一缺口是安全组**。

## 当前实际生效的形态（02:5x，不需要动安全组）

用户暂时不想点安全组，于是改用 **Cloudflare 临时隧道**，已经跑通：

| 项 | 值 / 做法 |
|---|---|
| 程序 | `%LOCALAPPDATA%\cloudflared\cloudflared.exe`（2026.10.4） |
| 启动 | `%LOCALAPPDATA%\cloudflared\start-tunnel.cmd` → `tools/tunnel.ps1`（进程在就不重复启动，从日志抠 URL 写 `url.txt`） |
| 日志 | `%LOCALAPPDATA%\cloudflared\tunnel.log` |
| 当前公网地址 | 见 `%LOCALAPPDATA%\cloudflared\url.txt`（每次重启会变） |
| 自启 | 启动文件夹快捷方式 `dsh-cloudflared.lnk`（计划任务注册被系统拒绝：`Access is denied` 0x80070005） |
| 插件侧 | `cordis.patch.yml` 的 `tunnelUrlFile` 指向 `url.txt`，二维码自动跟随隧道地址 |
| 推送通道 | Cloudflare 会缓冲 chunked 响应 → SSE 穿不过去；客户端 4 秒收不到首帧自动切 **长轮询** `/api/poll` |

实测过的完整链路（经公网隧道）：

```
GET /                     → 200 (3.7 KB)
POST /api/pair (扫码换密钥) → 200，设备密钥 101 字符
GET /api/state            → 29 个会话 + 标题 + 模型投影
GET /api/catalog          → 4 个 provider 组
GET /api/poll             → 空闲 25 秒空返回；有新事件时立即返回（实测收到 tool/result）
GET /admin                → 403（配对页只允许本机）
```

## 还差的一步（用户手动，我没法代做）

阿里云控制台 → ECS → 实例 → 安全组 → 配置规则 → **入方向** → 手动添加两条：

| 协议 | 端口范围 | 授权对象 | 用途 |
|---|---|---|---|
| TCP | 7000/7000 | 0.0.0.0/0 | frp 控制口（电脑连服务器） |
| TCP | 7788/7788 | 0.0.0.0/0 | 手机访问入口 |

> 想更严一点：7000 的授权对象可以填你家宽带的公网 IP（会变，变了要改）；7788 必须对全网开放才能随时随地用手机。

## 放行后的验收

1. 手机浏览器打开 `http://8.152.5.127:7788` → 应看到"配对"页（不是"打不开"）。
2. 电脑打开 `http://127.0.0.1:7788/admin` → 页面里出现二维码（二维码内容就是上面那个地址 + 一次性配对码）。
3. 手机扫码 → 进入会话列表 → 点任意会话 → 能看到历史、能发消息。
4. 断网重连：手机飞行模式开关一次，回到页面应自动用游标补齐，不重复下载历史。

## 后续可选项

- 想支持"完全断网也能打开"→ 需要 HTTPS（域名 + Caddy，Caddyfile 已放在 `/root/dsh-deploy/`）。
- 想省更多流量 → 会话列表可以关掉"工具输出折叠内容"，目前默认只发摘要。
