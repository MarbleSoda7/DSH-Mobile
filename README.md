# 手机接管 DSH（dsh-mobile-remote）

在手机上以 PWA 的形式远程接管电脑上的 DeepSeek Harness：看会话、收发消息、切模型和思考强度、
作答宿主提问、终止本轮、排队发送。数据在手机本地缓存（IndexedDB），每次只按 `seq` 游标取增量。

- 电脑本机配对页：`http://127.0.0.1:7788/admin`
- 固定手机入口（当前部署）：`http://8.152.5.127:7788`
- 方案：`PLAN.md`；部署与现状：`deploy/DEPLOY.md`、`deploy/INSTALLED-STATE.md`；手机上手：`手机使用指南.md`

## 形态

```
电脑（开着 DSH）                         手机
┌────────────────────────────┐          ┌──────────────────────────┐
│ DSH 桌面端 (Web GUI)        │          │ 浏览器 / 主屏幕 PWA      │
│   └ sessionController       │  SSE/    │  · 会话列表（本地优先）  │
│   └ session/event 事件流    │  长轮询  │  · 聊天（增量 + 断线续传）│
│ 本插件 :7788（自建监听器）  │ ←──────→ │  · 模型/强度切换         │
│   · /            手机外壳   │  REST    │  · 问答/终止/排队        │
│   · /admin       扫码配对   │          │  IndexedDB 缓存          │
│   · /api/*       业务接口   │          └──────────────────────────┘
└────────────────────────────┘
```

插件**不碰**宿主 Web GUI 端口，自带一个只监听 `127.0.0.1:7788` 的服务器，
所以把这一端口交给隧道（SSH 反向隧道 / frp）就等价于把手机接管能力发布出去，边界清晰。

推送有两条通道：SSE 与长轮询。Cloudflare 临时隧道会把分块响应缓冲到结束才下发，
SSE 在那种链路上收不到任何数据，所以客户端 4 秒收不到 `hello` 会自动切到长轮询；
明文直连（当前 8.152.5.127:7788 形态）两条都正常。

## 结构

```
lib/            Host 插件（Node，无依赖）
  index.js      自建 HTTP/SSE/长轮询服务、认证、事件桥、模型/问答/排队代理、隧道托管
  queue-state.js 排队消息的唯一模型（spliced 索引必须与宿主一致）
web/            手机端 PWA（原生 JS，无构建）
  index.html    会话列表 / 聊天 / 模型 sheet / 问答 sheet
  app.js        IndexedDB 缓存、增量同步、时间线渲染、Markdown、手势
  style.css     深色移动优先样式
  sw.js         外壳缓存（SHELL 版本变更时提版）
  admin.html    电脑本机配对页（二维码 + 配对码 + 设备管理）
tools/          回归与真机链路测试
deploy/         VPS（frps/Caddy、sshd GatewayPorts）与本机（frpc / SSH 反向隧道）脚本与现状
```

## 开发

插件已装进 `desktop` profile（`@local/dsh-mobile-remote` → 本目录的 junction）。

- `web/*` 由磁盘直读，**改完即生效**（`index.html` 里的资源引用带 `?v=<REV>` 穿透缓存）。
- `lib/*.js` 由插件自带的自动重载接管：改完约 2 秒自动重载，`POST /api/dev/reload`（仅回环）
  可手动触发；重载失败会自动回滚到上一实例。自建重载必须整条 import 链破缓存
  （见 `lib/index.js` 顶部的 `SELF_VERSION`），否则子依赖会跑旧版。
- 改完源文件一律用编辑工具，不要用 PowerShell 的 `Get-Content`/`Set-Content`：本机是
  Windows PowerShell 5.1，会把无 BOM 的 UTF-8 按 ANSI 解码，中文和换行都会坏。

## 测试

本机没有全局 `node`，用
`C:\Users\29113\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`。

| 脚本 | 覆盖 |
|---|---|
| `tools/smoke.mjs` | 假 ctx 驱动插件的协议级回归（认证、状态、分页、队列、问答、审批、ptc 子调用） |
| `tools/timeline-probe.mjs` | 假 DOM 跑 `web/app.js`：乱序、迟到 delta、插话去重、行折叠、翻页、截断展开 |
| `tools/probe-summary.mjs` | 工具行文案（动作词、描述优先、体积与行数） |
| `tools/check-queue-steer.mjs` | 排队模型（隐藏再确认、索引不漂移，含反向对照） |
| `tools/live-timeline.mjs`、`paging-live.mjs`、`steer-live.mjs`、`steer-one-of-two.mjs` | 打真实宿主的端到端链路 |
| `tools/public-ip-check.mjs` | 公网入口连通性与安全边界（`/admin`、非回环配对必须 403） |
| `tools/make-bug-copy.mjs` | 造反向对照副本（强制 `--src`/`--out`，并断言两者不同） |

断线续传、省流量的设计要点：客户端游标只由真正收到的帧推进；`hello` 与每次长轮询都带
权威队列快照；静态资源走 ETag/304；历史按轮分页（`hasMore` 为空页时自动加大页重试）。

## 安全边界

- 设备令牌 = `<uuid>.<32 字节 hex>`，服务端只存 `sha256`，可单台撤销。
- `/admin`、`/api/paircode`、`/api/devices*`、`/api/usage`、`/api/dev/reload` 仅回环可用。
- 明文 HTTP 下功能完整，但 Service Worker 不注册（完全断网打不开）、无法装成独立 App；
  要 HTTPS 就给服务器配域名 + Caddy。
- 微信小程序需要企业主体、备案与 HTTPS 白名单，当前形态是 PWA。
