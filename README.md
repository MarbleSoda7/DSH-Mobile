# DSH Mobile Remote

用手机接管电脑上的 **DeepSeek Harness**：扫一次二维码，然后在手机上查看会话列表、收发消息、切换模型与思考强度、回答宿主提问、终止本轮、排队插话——全部走增量同步，手机上还能离线缓存。

插件不碰 DSH 自己的 Web GUI 端口，自带一个只监听 `127.0.0.1:7788` 的 HTTP/SSE 服务。把这一个端口交给隧道，就等于把「手机接管能力」发布出去，边界非常清楚：**别的端口对公网一无所知**。

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
└──────────────────────────────┘
```

## 安装

**完整的分步说明（含排错表）见 [INSTALL.md](./INSTALL.md)。** 下面是浓缩版。

插件是标准的 DSH 宿主插件（`cordis.patch.yml` + `lib/index.js`），纯 ESM，**不需要安装任何 npm 依赖**，
也不用 `pnpm add`——它是以 junction 挂进 profile 的本地包。

```powershell
cd "$env:USERPROFILE\Desktop"
git clone https://github.com/MarbleSoda7/DSH-Mobile.git dsh-mobile-remote

$plugin  = "$env:USERPROFILE\Desktop\dsh-mobile-remote"
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"          # profile 名不同的话改这里
New-Item -ItemType Directory -Force -Path "$profile\node_modules\@local" | Out-Null
cmd /c mklink /J "$profile\node_modules\@local\dsh-mobile-remote" "$plugin"
```

然后在 profile 的 bundle patch（`cordis.patch.yml`）里插入：

```yaml
- insert:
    - id: mobile-remote
      name: '@dsh-plugin/mobile-remote'
      config:
        host: '0.0.0.0'      # 同一 WiFi 下手机直连；只本机用就写 '127.0.0.1'
        port: 7788
```

重启 DSH，打开 `http://127.0.0.1:7788/api/health` 能返回 `{"ok":true,...}` 即加载成功。生成二维码有两种入口：

- **DSH 界面左下侧边栏的手机图标**：点开就是二维码 + 连接状态，配对后不用再开浏览器。
- **`http://127.0.0.1:7788/admin`**：这个页面**只有本机能开**，外网一律 404。

二维码是插件自己编码生成的，**不依赖 profile 里是否装了 `qrcode` 包**，换电脑也不会白屏。
电脑有多张网卡（VPN / WSL / Docker 虚拟网卡）时，面板上可以手动选「手机用哪个地址」。

## 让手机连上

`127.0.0.1` 手机是访问不到的，二选一：

### A. 局域网直连（最简单，同一 WiFi 下）

```yaml
config:
  host: '0.0.0.0'                            # 监听所有网卡
  publicOrigin: 'http://192.168.1.10:7788'   # 换成你电脑的局域网 IP
```

手机和电脑连同一个 WiFi，扫 `/admin` 上的码即可。**公网上不要这样配。**

### B. 公网访问（用隧道，推荐）

外网只暴露一个端口，两种常见做法：

**SSH 反向隧道**（插件自己托管，需要一台有公网 IP 的服务器）：

```yaml
config:
  publicOrigin: 'http://your-server:7788'
  tunnel:
    enabled: true
    server: 'your-server'
    user: root                 # 建议用专用账号，见下方安全说明
    remotePort: 7788           # 同一台服务器上每台电脑占一个不同端口
    localPort: 7788
    keyPath: 'C:/Users/you/.ssh/id_ed25519'
```

服务端 sshd 需要 `GatewayPorts clientspecified`，防火墙放行该端口。

**Cloudflare Tunnel / frp**：把 `127.0.0.1:7788` 转发到你的域名，再把 `publicOrigin` 配成那个域名。走 HTTPS 时手机上还能注册 Service Worker，完全断网也能打开外壳。

推送通道有两条：SSE 与长轮询。Cloudflare 的临时隧道会缓冲分块响应，SSE 在那种链路上收不到数据，所以客户端 4 秒收不到 `hello` 会自动切到长轮询，不需要手动干预。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 监听地址，局域网直连时改 `0.0.0.0` |
| `port` | `7788` | 监听端口 |
| `publicOrigin` | 空 | 手机入口地址；留空则用隧道自报地址，再退回局域网 IP |
| `tunnelUrlFile` | 空 | 隧道把最新地址写进文件时，从该文件读入口 |
| `stateDir` | 插件目录 | `devices.json` / `usage.json` / `tunnel.json` 的存放目录 |
| `maxDevices` | `1` | 同时可绑定的手机数；`1` 时新配对会替换旧设备，`0` = 不限 |
| `pairCodeTtlMs` | `120000` | 配对码有效期（2 分钟），一次性 |
| `maxEventChars` | `4000` | 单条事件在手机上保留的最大字符数（超出截断可展开） |
| `autoReload` | `true` | `lib/*.js` 改动后自动重载，失败自动回滚 |
| `tunnel.*` | 关闭 | 让插件托管 SSH 反向隧道，见上 |

隧道参数也可以写到 `<stateDir>/tunnel.json`，改隧道不用重新安装包。

## 安全边界

- 设备令牌 = `<id>.<32 字节 hex>`，服务端只存 `sha256`，可单台撤销。
- 配对码：**只能从回环地址生成**、2 分钟有效、**一次即焚**。
- `/admin`、`/api/paircode`、`/api/devices*`、`/api/usage`、`/api/dev/reload` 仅回环可用；未带设备 cookie 直接访问 `/` 返回 404，所以「扫端口」看不到任何东西。
- `maxDevices=1` 时新设备配对会立刻踢掉旧设备，旧手机下一次请求就是 401 并显示「已被新的配对替换」——这是你发现「别人连上了」的信号。
- **手机是客户端，电脑是服务器**：拿到电脑执行权限的人可以绕过上面一切（改 `devices.json`、走回环重签）。所以别把这套当成「保护一台已经被攻破的电脑」的方案，它的价值是**让你知道发生了这件事**，并随时能一键撤销。
- 明文 HTTP 下功能完整，但 Service Worker 不注册（完全断网打不开）、装不成独立 App。
- **服务器侧**：插件用的 SSH 部署密钥是公开在仓库里的共享秘密（每台电脑同一把），
  所以服务器上必须用 `restrict,port-forwarding,command="/usr/sbin/nologin"` 限定它只能转发，
  并关掉 root 密码登录。**不这样做等于把服务器 root shell 公开给所有人**，部署方式见
  [`deploy/SECURITY.md`](deploy/SECURITY.md)。

## 开发

```bash
node tools/smoke.mjs           # 协议层回归：假 ctx 驱动插件，覆盖认证/状态/分页/队列/问答/审批
node tools/timeline-probe.mjs  # 前端回归：假 DOM 跑 web/app.js，覆盖乱序/迟到 delta/插话去重/折叠/翻页
```

两个脚本都不需要真实 DSH，也不联网。

- `web/*` 由磁盘直读，改完刷新即生效（`index.html` 的资源引用带 `?v=<REV>` 破缓存；改了前端记得同时提 `REV` 和 `web/sw.js` 的 SHELL 版本）。
- `lib/*.js` 由插件自带的重载接管：改完约 2 秒自动生效，`POST /api/dev/reload`（仅回环）可手动触发。

## 结构

```
lib/
  index.js        HTTP/SSE/长轮询服务、认证、事件桥、模型/问答/排队代理、隧道托管
  queue-state.js  排队消息的唯一模型（spliced 索引必须与宿主一致）
web/              手机端 PWA（原生 JS，无构建）
  index.html      会话列表 / 聊天 / 模型 sheet / 问答 sheet
  app.js          IndexedDB 缓存、增量同步、时间线渲染、Markdown、手势
  style.css       深色移动优先样式
  sw.js           外壳缓存（SHELL 版本变更时提版）
  admin.html      本机配对页（二维码 + 配对码 + 设备管理）
tools/
  smoke.mjs       协议级回归
  timeline-probe.mjs  前端回归
locale/           插件描述的中英文本
```

## License

MIT
