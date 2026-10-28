# 部署：手机通过云服务器 8.152.5.127 接管

目标链路，压缩成一句话：**手机 → Caddy(TLS) → frp 服务端 → frp 客户端(你的电脑) → 插件 127.0.0.1:7788 → DSH**。

```
手机 (PWA)                云服务器 8.152.5.127                 你的电脑
   │ https://dsh.你的域名        │                                │
   └─────────────► Caddy :443 ──► 127.0.0.1:7788 (frps 借出) ◄──── frpc ──► 127.0.0.1:7788
                                  ▲ 控制口 7000 ◄──────────────── 出站连接
```

方向很重要：**电脑主动连服务器**，服务器不发起连接，所以电脑在 NAT/公司网/酒店网都能用，只要它开着。
电脑关机期间手机连不上——这是当前阶段的已知边界，不是 bug。

## 0. 先选一条 TLS 路线

TLS 不只是"加密好看"：手机的 Service Worker（离线缓存、添加到主屏幕）**只在 HTTPS 下可用**。

| 你的条件 | 走哪条 | 手机地址 |
| --- | --- | --- |
| 有域名，且已 ICP 备案（大陆服务器必须） | **A. Caddy 自动签证书**（推荐） | `https://dsh.你的域名` |
| 有域名但没备案 | **B. 非标端口 + 自签证书** | `https://dsh.你的域名:8443`（首次需手动信任） |
| 没有域名 | **C. 先明文跑通** | `http://8.152.5.127:7788` |

C 路线能用，但没有离线缓存和"添加到主屏幕"，且链路上是明文（你之前说过可以接受）。

## 1. 阿里云安全组放行

控制台 → 安全组 → 入方向，加两条：

| 端口 | 用途 |
| --- | --- |
| TCP 7000 | frp 控制口（电脑连服务器） |
| TCP 80 + 443（路线 A） / 8443（路线 B） / 7788（路线 C） | 手机访问 |

安全组没放行的话，下面所有步骤都会"看起来装好了但连不上"——这是第一排查项。

## 2. 服务器：装 frps

把 `deploy/vps/` 两个文件传到服务器（`scp deploy/vps/* root@8.152.5.127:/root/`），然后：

```bash
ssh root@8.152.5.127
cd /root && sudo FRP_TOKEN='自己编一个 40 位随机串' bash setup-frps.sh
```

脚本会：装 frp → 写 `/etc/frp/frps.toml`（只允许代理 7788 端口）→ 注册 systemd → 启动 → 打印 token 和仪表盘口令。
重复执行是安全的（已有配置会保留）。

验证：

```bash
systemctl status frps --no-pager | head -5
ss -lntp | grep -E '7000|7788'
```

## 3. 服务器：装 Caddy（路线 A/B）

路线 C 可跳过这一步。

**Debian/Ubuntu：**

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

**Caddyfile（路线 A）：** 把 `deploy/vps/Caddyfile` 拷到 `/etc/caddy/Caddyfile`，把 `dsh.example.com` 换成你的域名、
`you@example.com` 换成你的邮箱，域名 A 记录指向 `8.152.5.127`，然后：

```bash
sudo systemctl reload caddy
sudo journalctl -u caddy -n 30 --no-pager    # 看证书有没有签下来
```

**路线 B（无备案）**：Caddyfile 改成

```
dsh.example.com:8443 {
	tls internal
	encode zstd gzip
	@admin path /admin /admin/*
	respond @admin 403
	reverse_proxy 127.0.0.1:7788 {
		flush_interval -1
	}
}
```

`tls internal` 用的是 Caddy 自签 CA，手机首次打开需点"继续访问"（iOS 还要在设置里信任）。

## 4. 电脑：装 frpc

```powershell
cd D:\SDU\IC\HarnessProject\guide-dog-peta\dsh-mobile-remote\deploy\pc
powershell -ExecutionPolicy Bypass -File .\setup-frpc.ps1 -Token "<第 2 步打印的 token>"
```

它会：下载 frpc 到 `%LOCALAPPDATA%\frp`、写 `frpc.toml`、注册"登录时自启"计划任务、立刻拉起、并探测服务器 7000/7788 两个端口。

验证（在服务器上）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7788/api/health   # 期望 200
```

看到 200 说明"电脑 → 服务器"这段通了。

## 5. 插件：配置对外地址

打开插件包自己的 `cordis.patch.yml`，把 `publicOrigin` 填成手机最终要访问的地址：

```yaml
- insert:
    - id: mobile-remote
      name: '@dsh-plugin/mobile-remote'
      config:
        host: 127.0.0.1
        port: 7788
        publicOrigin: 'https://dsh.你的域名'   # 路线 B 写 https://dsh.你的域名:8443，路线 C 写 http://8.152.5.127:7788
```

然后在 DSH 面板里对这个插件 **remove_bundle → install_bundle** 一次（或重启 DSH）。
之后 `/admin` 页面生成的二维码就会直接指向这个地址。

## 6. 手机：扫码接管

1. 电脑浏览器打开 <http://127.0.0.1:7788/admin>（**只有本机能打开**，公网访问 /admin 会被 403）。
2. 手机扫码（微信扫也行，选"在浏览器打开"）。
3. 页面自动完成配对；iOS 用「分享 → 添加到主屏幕」，Android 用「⋮ → 添加到主屏幕」。
4. 之后从主屏幕图标进入，就是全屏 App 的观感。

## 7. 验收清单

| 检查 | 期望 |
| --- | --- |
| `https://域名/api/health` | `{"ok":true,...}` |
| 手机打开首页 | 出现会话列表，标题/运行状态对得上电脑 |
| 点开一个正在跑的会话 | 能看到已生成的历史，并且新消息会自己冒出来 |
| 手机发一句话 | 电脑上 DSH 开始回复，手机流式看到 |
| 点模型按钮 | 能切 provider/模型/思考强度，电脑端设置同步变化 |
| DSH 弹提问 | 手机弹底部抽屉，选项可点、可填自定义答案 |
| 点"停止" | 电脑端本轮真的停了 |
| 电脑上杀掉 frpc 再启动 | 手机端 30 秒内自动重连（状态点变绿） |

## 8. 排障

| 现象 | 原因 → 处理 |
| --- | --- |
| 手机打不开，`curl 127.0.0.1:7788` 在服务器上也不通 | frpc 没连上：看 `%LOCALAPPDATA%\frp\frpc.log`，多为 token 不一致或安全组没放行 7000 |
| 服务器 7788 通但域名打不开 | Caddy 没起/域名没解析/备案问题：`journalctl -u caddy -n 50` |
| 打开是 502 | Caddy 反代到了 7788 但插件没跑：电脑上 `curl 127.0.0.1:7788/api/health` |
| 页面 403 且提示"只允许在电脑上打开" | 你访问的是 `/admin`：换成 `/`（手机主界面） |
| 消息要等整条生成完才出现 | 反代缓冲：确认 Caddy 里保留了 `flush_interval -1` |
| 手机提示"未配对或密钥失效" | 设备被撤销或 stateDir 被清：重新在电脑上出码扫码 |
| 443 端口被运营商/阿里云拦截 | 未备案域名走 443 会被拦：换路线 B（8443）或 C |
