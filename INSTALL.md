# 安装 DSH Mobile Remote

手机接管电脑上的 DeepSeek Harness。装完在电脑上开 `http://127.0.0.1:7788/admin` 扫码就能用。

**不需要装任何 npm 依赖**，二维码是自己编码的，不依赖 `qrcode` 包。

---

## 0. 先确认一件事

DSH 的插件**必须挂在某个 profile 下**。先确认你的 profile 目录（下面用 `%USERPROFILE%\.dsh\profiles\desktop` 举例，profile 名不是 `desktop` 的话自己换）：

```powershell
dir "$env:USERPROFILE\.dsh\profiles"
```

看到 `desktop`（或你自己用的那个名字）就对了。

---

## 1. 下载插件

```powershell
cd "$env:USERPROFILE\Desktop"
git clone https://github.com/MarbleSoda7/DSH-Mobile.git dsh-mobile-remote
```

没有 git 的话，去仓库页面点 **Code → Download ZIP**，解压到 `%USERPROFILE%\Desktop\dsh-mobile-remote`。

---

## 2. 挂进 profile

在 profile 目录下建一个指向插件目录的 **junction**（不需要管理员权限）：

```powershell
$plugin  = "$env:USERPROFILE\Desktop\dsh-mobile-remote"
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Directory -Force -Path "$profile\node_modules\@local" | Out-Null
cmd /c mklink /J "$profile\node_modules\@local\dsh-mobile-remote" "$plugin"
```

看到 `为 ... 创建的联接` / `Junction created` 就成功了。

> `@local` 这个 scope 是刻意的：包名是 `@local/dsh-mobile-remote`，不是从 npm 装的，
> 所以**千万不要**用 `pnpm add` 去装它，那个会变成 git 依赖然后失败。

---

## 3. 写配置

打开（没有就新建）`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，
**追加**下面这一段（如果文件里已经有 `mobile-remote` 条目就跳过这步）：

```yaml
- insert:
    - id: mobile-remote
      name: '@local/dsh-mobile-remote'
      config:
        host: '0.0.0.0'
        port: 7788
```

`host: '0.0.0.0'` 表示同一个 WiFi 下手机能直连。只想本机用就写 `'127.0.0.1'`。

---

## 4. 重启 DSH

关掉 DSH 再打开（不是最小化，要真的退出）。

---

## 5. 验证

浏览器打开 `http://127.0.0.1:7788/api/health`，应该看到：

```json
{"ok":true,"rev":"r2026-10-28-builtinqr56",...}
```

看到了就说明插件跑起来了。

---

## 6. 手机连接

电脑浏览器打开 **`http://127.0.0.1:7788/admin`**，页面上有二维码和配对链接。

- 手机和电脑连**同一个 WiFi**，直接扫二维码。
- 二维码里的地址形如 `http://192.168.x.x:7788/?t=...`。如果电脑有多张网卡
  （VPN / WSL / Docker / Radmin / Tailscale），`/admin` 页面上可以手动换地址。
- 配对码 **2 分钟过期、一次即焚**，过期了点「换一个二维码」。

进不去的话依次查：

| 现象 | 原因 |
|---|---|
| 手机一直转圈 / 打不开 | Windows 防火墙拦了 7788。控制面板 → Windows Defender 防火墙 → 高级设置 → 入站规则 → 新建规则，TCP 放行 7788 |
| 命令行 `ping` 不通 | 不在同一个网段，或者路由器的「AP 隔离 / 访客网络」开着 |
| 手机打开提示「已被新的配对替换」 | 只允许一台手机。再配一台会把旧的踢掉（`maxDevices: 1`） |
| 页面能开但列表是空的 | 电脑上的 DSH 没开任何会话 |

---

## 7. 公网访问（不在同一 WiFi 时）

外网访问必须走隧道，别直接把 7788 暴露到公网。两种做法见仓库 `README.md` 的
「让手机连上 → B. 公网访问」，配好后把 `publicOrigin` 填成你的域名或服务器地址：

```yaml
      config:
        host: '127.0.0.1'
        port: 7788
        publicOrigin: 'https://你的域名'
        tunnel:
          enabled: true
          server: '你的服务器 IP'
          user: root              # 建议换专用账号
          remotePort: 7788        # 一台服务器上每台电脑要错开
          keyPath: 'C:/Users/你/.ssh/id_ed25519'
```

---

## 卸载

删掉 junction 和配置段，重启 DSH：

```powershell
cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dsh-mobile-remote"
```

`rmdir` 删 junction 只删链接，不会删 `Desktop\dsh-mobile-remote` 里的东西。

---

## 常见问题

**插件管理页显示「等待依赖」**
`inject` 里声明了 profile 没有的服务。本仓库当前版本已经是 `['sessionController']`，
如果你看到这个提示，说明下载的是旧版（`git pull` 更新）。

**`/api/health` 打不开，但 DSH 界面正常**
插件没加载。看 DSH 日志里有没有 `[mobile-remote]`；没有的话检查第 2 步 junction 和第 3 步的 yaml 缩进。

**二维码区域是空白**
旧版依赖 `qrcode` 包。`git pull` 到最新版本即可，现在不依赖任何外部包。
