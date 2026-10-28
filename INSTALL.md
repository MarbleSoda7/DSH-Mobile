# 安装 DSH Mobile Remote

手机接管电脑上的 DeepSeek Harness。

**装完即用，不需要 git、不需要 pnpm、不需要管理员权限、不需要 7-Zip。**

---

## 一句话版本

下载 `DSH-Mobile-Setup.exe`，双击，按提示点完，重启 DSH。

---

## 它到底做了什么

安装器不会碰 DSH 自己的安装目录，全部活在当前用户下：

| 步骤 | 位置 |
| --- | --- |
| 插件本体 | `%LOCALAPPDATA%\DSH-Mobile\app` |
| 挂进 profile | `<profile>\node_modules\@local\dsh-mobile-remote`（junction，指向上面的 app） |
| 注册插件 | `<profile>\cordis.patch.yml` 里追加一条 `insert:` |

junction 和符号链接不同，**不需要管理员权限**。反复运行安装器是安全的：已存在的会覆盖更新，patch 里已有的条目不会重复插入。

---

## 完整步骤

### 1. 先打开一次 DSH

安装器要把插件挂进某个 profile。**profile 是 DSH 首次启动时才创建的**，所以请先运行一次 DeepSeek Harness，看到界面就行，不需要做什么。

### 2. 双击 `DSH-Mobile-Setup.exe`

会弹一个控制台窗口，最后有自检清单：

```
自检：
  [OK]   宿主入口  (128,290 字节)
  [OK]   二维码编码器  (18,365 字节)
  [OK]   手机端外壳  (148,084 字节)
  [OK]   管理页  (16,343 字节)
  [OK]   配对浮层  (16,535 字节)
  [OK]   frpc 隧道  (15,523,328 字节)
```

有多个 profile 时会让你选装进哪一个。

### 3. 重启 DSH

### 4. 扫码

打开 `http://127.0.0.1:7788/admin`，用手机扫二维码。

也可以点 **DSH 侧边栏底部的手机图标**，效果一样。

---

## 装完自检

浏览器打开 `http://127.0.0.1:7788/api/health`，看到：

```json
{"ok":true,"rev":"...","devices":0,"streams":0}
```

就说明插件起来了。

也可以看 `http://127.0.0.1:7788/api/identity`：

```json
{"ok":true,"deviceId":"dev_...","port":9001,"state":"ok","origin":"http://8.152.5.127:9001"}
```

`port` 是你这台机器分到的公网端口，`origin` 就是二维码里编进去的地址。

---

## 出问题怎么办

### `找不到任何 profile`

DSH 还没启动过。先跑一次 DSH，再重新执行安装器。

### `/api/health` 打不开

1. 确认 DSH 重启过（不是只开了窗口）
2. 确认 `cordis.patch.yml` 里有一行 `id: mobile-remote`
3. 看 DSH 的日志里有没有 `[mobile-remote]`

### `identity` 里 `state` 不是 `ok`

| state | 含义 | 怎么办 |
| --- | --- | --- |
| `offline` | 连不上分配服务器 | 检查网络能否访问 `8.152.5.127:7789` |
| `rejected` | 服务器拒绝 | 端口池满了，或者服务器换了地址 |
| `no-frpc` | 找不到 frpc.exe | 重新跑安装器（自检里这一项会标红） |
| `full` | 20 个槽位全满 | 等别人下线，或联系服务器维护者 |

### 手机扫码提示「网页拒绝了您的访问」

这个提示来自服务器，不是手机。说明你分到的端口上没有代理在监听——通常是本机 frpc 没起来。看 `%USERPROFILE%\.dsh\dsh-mobile-remote\frpc.log`。

---

## 卸载

```powershell
# 1. 从 patch 里删掉 mobile-remote 那几段（或整段 insert）
notepad "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml"

# 2. 摘掉 junction
cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dsh-mobile-remote"

# 3. 删本体
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\DSH-Mobile"
```

配对记录和身份留在 `%USERPROFILE%\.dsh\dsh-mobile-remote\`，要彻底清掉也一起删。

---

## 自己打包安装包

安装器用的是 .NET 的 zip 嵌入方案，开发机只要有 Windows 和 Node 就行：

```powershell
node tools/make-installer.mjs
# → dist\DSH-Mobile-Setup.exe（约 6 MB）
```

不做压缩、只看收集了哪些文件：

```powershell
node tools/make-installer.mjs --no-zip
# → dist\staging\
```

---

## 开发者：手工安装

不想用安装器的话，原来的方式仍然有效。

```powershell
$plugin  = "D:\path\to\dsh-mobile-remote"
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"

New-Item -ItemType Directory -Force -Path "$profile\node_modules\@local" | Out-Null
cmd /c mklink /J "$profile\node_modules\@local\dsh-mobile-remote" "$plugin"
```

然后往 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: mobile-remote
      name: '@local/dsh-mobile-remote'
      config:
        host: '127.0.0.1'
        port: 7788
```

**注意**：手工装时，`deploy/pc/frpc.exe` 必须跟着插件目录一起在。安装器会把它放到 `%LOCALAPPDATA%\DSH-Mobile\app\deploy\pc\`，手工装则要保证 `$plugin\deploy\pc\frpc.exe` 存在——插件会自动去这几个地方找：

1. 配置里的 `tunnel.frpcPath`
2. 插件目录下的 `deploy/pc/frpc.exe`
3. `%USERPROFILE%\.dsh\dsh-mobile-remote\frpc.exe`

找不到时 `/api/identity` 的 `state` 会是 `no-frpc`，`error` 里写着该放到哪里。
