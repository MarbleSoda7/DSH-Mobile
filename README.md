# DSH Mobile Remote

用手机接管电脑上的 **DeepSeek Harness**：扫一次二维码，然后在手机上查看会话列表、收发消息、切换模型与思考强度、回答宿主提问、终止本轮、排队插话——全部走增量同步，手机上还能离线缓存。

插件不碰 DSH 自己的 Web GUI 端口，自带一个 HTTP/SSE 服务（默认 `0.0.0.0:7788`）。把这一个端口交给隧道，就等于把「手机接管能力」发布出去，边界非常清楚：**别的端口对公网一无所知**。

```
电脑（DSH 正在运行）                        手机
┌──────────────────────────────┐          ┌───────────────────────────┐
│ DSH 桌面端 (Web GUI)          │          │ 浏览器 / 主屏幕 PWA        │
│   └ sessionController         │  SSE /   │  · 会话列表（本地优先）    │
│   └ session/event 事件流      │  长轮询   │  · 聊天（增量 + 断线续传） │
│ 本插件 :7788（自建监听器）    │ ←──────→ │  · 模型 / 强度切换         │
│   · /          手机外壳       │  REST    │  · 问答 / 终止 / 排队      │
│   · /admin     扫码配对       │          │  IndexedDB 缓存            │
│   · /api/*     业务接口       │          └───────────────────────────┘
└──────────────┬───────────────┘
               │ 内置隧道（纯 Node，WebSocket）
               ▼
   公网服务器 8.152.5.127:9000-9099
```

## 安装

插件是标准的 DSH 宿主插件（`cordis.patch.yml` + `lib/index.js`），纯 ESM，**没有任何 npm 依赖**，也不随包分发任何可执行文件——隧道、二维码编码器全部是插件自己的 JS。

在 DSH profile 的 `package.json` 里加一行依赖，然后 `pnpm install`、重启 DSH：

```jsonc
{
  "dependencies": {
    "@dsh-plugin/mobile-remote": "github:MarbleSoda7/DSH-Mobile#publish"
  }
}
```

`publish` 分支是稳定版；想跟最新改动用 `#main`。完整步骤（含找不到 profile、pnpm 路径、卸载）见 [`INSTALL.md`](INSTALL.md)。

装完验证：浏览器打开 `http://127.0.0.1:7788/api/health`，看到 `{"ok":true,"rev":"..."}` 即成功。

## 用起来

生成二维码有两个入口，效果一样：

- **DSH 界面左下侧边栏的手机图标**：点开就是二维码 + 连接状态
- **`http://127.0.0.1:7788/admin`**：这个页面**只有本机能开**，外网一律 404

手机扫码后自动完成绑定，之后打开手机浏览器就能用。`maxDevices` 默认 1，用新手机绑定时旧手机会自动断开并提示「已被新的配对替换」。

二维码是插件自己编码生成的，**不依赖 profile 里是否装了 `qrcode` 包**，换电脑也不会白屏。

## 网络是怎么打通的

**服务器地址写死**在 `lib/index.js`（`SERVER_HOST`），**端口由服务器分配**，本机没有任何可选项。第一次启动时插件向服务器的 `/api/claim` 报到，服务器在 9000–9099 里挑一个空位给它，把 `deviceId` / `secret` / `token` / `port` 一起下发，存在 `<stateDir>/identity.json`。

之后每次启动都拿 `deviceId + secret` 去续约，**端口不变**。手机上的二维码地址永远是 `http://8.152.5.127:<你的端口>`，换 WiFi、换网络环境都不影响。

```
手机 → 8.152.5.127:9001 ──Caddy 7789 /tunnel──→ 你的电脑 :7788
```

服务器对公网只开一个口：7789。上面按路径分流——`/api/*` 给分配接口，`/tunnel` 给隧道服务。

手机和电脑在同一个 WiFi 下时，还可以直接访问电脑的局域网 IP（插件默认监听所有网卡），不依赖服务器。

## 端口会被别人抢走吗

不会。端口跟**机器身份**绑定，不跟连接状态绑定：

- 你关掉 DSH、断网、关机，`9000` 仍然记在你名下，别人拿不到
- 重新启动后拿回的**还是原来那个端口**，手机上的二维码不用重新扫
- 只有连续 **7 天**没向服务器露过面，端口才会被回收给新机器
- 端口池满了（100 台都用完）时，服务器会借走最久没露面的那一台

## 自愈

隧道断了会自己重连，这几种情况都不需要人管：

| 情况 | 行为 |
| --- | --- |
| 网络抖动、控制通道断开 | 指数退避重连（2s 起，30s 封顶） |
| 服务器重启 | 同上，恢复后自动续约 |
| **服务器不认你的 token**（台账重置、端口被回收） | 丢掉旧 token，**重新 claim 领一份新的**，端口通常还是原来的 |
| 分配服务器本身连不上 | 每 15 秒重试一次 |

故障原因会如实写进 `identity.json`：

```json
{
  "port": 9000,
  "lastState": "disconnected",
  "lastError": "隧道握手超时"
}
```

`lastState` 只有在服务器真的回了 `ready` 之后才会是 `ok`——不会出现「文件写着 ok、实际上连不上」的情况。

## 配置项

全部可选，写在 `cordis.patch.yml` 的 `config:` 下，删掉即用默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `host` | `0.0.0.0` | 监听地址。想让手机**在同一 WiFi 下直连**就保持默认；只想走隧道写 `127.0.0.1` |
| `port` | `7788` | 监听端口，也是隧道倒流量的目标 |
| `stateDir` | `~/.dsh/dsh-mobile-remote` | `identity.json` / `devices.json` / `usage.json` / `plugin.log` 的存放目录 |
| `maxDevices` | `1` | 同时可绑定的手机数；`1` 时新配对会替换旧设备，`0` = 不限 |
| `pairCodeTtlMs` | `120000` | 配对码有效期（2 分钟），一次性 |
| `maxEventChars` | `4000` | 单条事件在手机上保留的最大字符数（超出截断可展开） |
| `autoReload` | `true` | `lib/*.js` 改动后自动重载，失败自动回滚 |
| `publicOrigin` | 空 | 兜底的固定入口地址，平时不用填 |
| `tunnel.localPort` | `7788` | 隧道把流量倒给本机的哪个端口 |
| `tunnel.frpServerPort` | `7789` | 服务器隧道控制端口 |

## 安全边界

- 设备令牌 = `<id>.<32 字节 hex>`，服务端只存 `sha256`，可单台撤销。
- 配对码：**只能从回环地址生成**、2 分钟有效、**一次即焚**。
- `/admin`、`/api/paircode`、`/api/devices*`、`/api/usage`、`/api/dev/reload` 仅回环可用；未带设备 cookie 直接访问 `/` 返回 404，所以「扫端口」看不到任何东西。
- `maxDevices=1` 时新设备配对会立刻踢掉旧设备，旧手机下一次请求就是 401 并显示「已被新的配对替换」——这是你发现「别人连上了」的信号。
- **手机是客户端，电脑是服务器**：拿到电脑执行权限的人可以绕过上面一切（改 `devices.json`、走回环重签）。所以别把这套当成「保护一台已经被攻破的电脑」的方案，它的价值是**让你知道发生了这件事**，并随时能一键撤销。
- 明文 HTTP 下功能完整，但 Service Worker 不注册（完全断网打不开）、装不成独立 App。
- 隧道是明文 WebSocket，**不提供端到端加密**，服务器维护者能看到流量内容。
- 服务器侧部署与威胁模型见 [`deploy/SECURITY.md`](deploy/SECURITY.md)。

## 开发

```bash
node tools/smoke.mjs           # 协议层回归：假 ctx 驱动插件，覆盖认证/状态/分页/队列/问答/审批
node tools/timeline-probe.mjs  # 前端回归：假 DOM 跑 web/app.js，覆盖乱序/迟到 delta/插话去重/折叠/翻页
node tools/test-tunnel.mjs     # 隧道端到端：起一个本机假服务，走完 open/data/close
```

三个脚本都不需要真实 DSH，也不联网。

- `web/*` 由磁盘直读，改完刷新即生效（`index.html` 的资源引用带 `?v=<REV>` 破缓存；改了前端记得同时提 `REV` 和 `web/sw.js` 的 SHELL 版本）。
- `lib/*.js` 由插件自带的重载接管：改完约 2 秒自动生效，`POST /api/dev/reload`（仅回环）可手动触发。
- 插件日志同时写进 `<stateDir>/plugin.log`——桌面版宿主会把 `console` 收走，排查只能靠这个文件。

## 结构

```
lib/
  index.js        HTTP/SSE/长轮询服务、认证、事件桥、模型/问答/排队代理、隧道托管
  tunnel.js       内置隧道客户端（纯 Node，WebSocket 分帧自己实现）
  qr.js           内置二维码编码器（只用 node:zlib，不依赖 qrcode 包）
  queue-state.js  排队消息的唯一模型（spliced 索引必须与宿主一致）
web/              手机端 PWA（原生 JS，无构建）
  index.html      会话列表 / 聊天 / 模型 sheet / 问答 sheet
  app.js          IndexedDB 缓存、增量同步、时间线渲染、Markdown、手势
  style.css       深色移动优先样式
  sw.js           外壳缓存（SHELL 版本变更时提版）
  admin.html      本机配对页（二维码 + 配对码 + 设备管理）
  pair-panel.js   DSH 侧边栏手机按钮 + 二维码浮层（注入到 DSH 页面）
deploy/vps/       服务端：端口分配 API + 隧道服务 + Caddy 配置
tools/            回归脚本与调试探针
locale/           插件描述的中英文本
```

## License

MIT
