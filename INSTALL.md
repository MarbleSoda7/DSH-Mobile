# 安装 DSH Mobile Remote

手机接管电脑上的 DeepSeek Harness。

安装方式只有一条：**往 DSH profile 的 `package.json` 里加一行依赖**。不需要 git 命令、不需要手动建目录、不需要编译。

---

## 装之前

先打开一次 DeepSeek Harness。**profile 是 DSH 首次启动时才创建的**，没启动过就没有可装的目录。

---

## 安装

### 找到 profile 的 package.json

Windows 上默认是：

```
C:\Users\<你的用户名>\.dsh\profiles\desktop\package.json
```

如果装过多个 profile，`profiles\` 下面会有多个目录，选你现在用的那个。

### 加一行依赖

用记事本打开它，在 `dependencies` 里加一项：

```jsonc
{
  "dependencies": {
    "@dsh-plugin/mobile-remote": "github:MarbleSoda7/DSH-Mobile#publish"
  }
}
```

注意 `dependencies` 里原来可能有别的东西，加进去就好，别忘了给上一项补逗号。

`#publish` 是稳定分支。想跟最新改动用 `#main`。

### 安装依赖

在 profile 目录里装依赖。用 DSH 自带的 pnpm：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
& "D:\Software\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\pnpm.cmd" install
```

装的是直接从 GitHub 拉的包，这台机器需要能访问 github.com。

### 确认插件被加载

profile 根目录的 `cordis.patch.yml` 里应该有（很多 profile 默认就有，没有就手动加）：

```yaml
- insert:
    - id: mobile-remote
      name: '@dsh-plugin/mobile-remote'
      config:
        host: '0.0.0.0'
        port: 7788
```

`config` 整段都可以删掉，全用默认值。

### 重启 DSH

关掉 DSH 进程，重新打开。

---

## 装完自检

浏览器打开 `http://127.0.0.1:7788/api/health`：

```json
{"ok":true,"rev":"r2026-10-29-selfheal63","devices":0,"streams":0,"pollers":0}
```

看到 `"ok":true` 就说明插件起来了。

再看 `http://127.0.0.1:7788/api/identity`：

```json
{"ok":true,"deviceId":"dev_...","port":9000,"state":"ok","origin":"http://8.152.5.127:9000"}
```

- `port` 是这台机器分到的公网端口
- `origin` 就是二维码里编进去的地址

---

## 用起来

两种方式打开配对页，效果一样：

- 点 **DSH 界面左下侧边栏的手机图标**
- 浏览器打开 `http://127.0.0.1:7788/admin`（**只有本机能开**，外网一律 404）

手机扫码，自动绑定，之后直接用。

---

## 出问题怎么办

### `/api/health` 打不开

1. 确认 DSH 真的重启过（关闭进程重开，不是只切窗口）
2. 确认 `cordis.patch.yml` 里有 `id: mobile-remote` 这一行
3. 看 `<stateDir>\plugin.log`，默认在 `%USERPROFILE%\.dsh\dsh-mobile-remote\plugin.log`

### `state` 不是 `ok`

| state | 含义 | 怎么办 |
| --- | --- | --- |
| `ok` | 隧道已就绪 | 正常 |
| `claiming` | 正在向服务器要端口 | 几秒后自动变 |
| `disconnected` | 隧道断了，正在重连 | 一般 30 秒内自己好；`lastError` 里写着原因 |
| `offline` | 连不上分配服务器 | 检查能否访问 `8.152.5.127:7789` |
| `rejected` | 服务器明确拒绝 | `lastError` 里有原文，通常是端口池满了 |
| `unconfigured` | 配置缺项 | 极少出现，看 `plugin.log` |

`state: disconnected` 且 `lastError` 是 `token 无权占用端口 X` 时，插件会**自动重新 claim**，不用管。

### 手机扫码提示「网页拒绝了您的访问」

这个提示来自服务器，不是手机——说明你那个端口上现在没有隧道在听。先看 `/api/identity` 的 `state`，再看 `plugin.log` 里隧道那段日志。DSH 刚重启后的十几秒内出现一次是正常的。

### 手机上打开就白屏

点一下手机浏览器的刷新。外壳是网络优先的，正常情况下刷新一次就拿到最新版。

### 二维码编不出地址

`/api/identity` 的 `origin` 为空，说明还没分到端口（`state` 不是 `ok`）。等隧道起来再刷一下配对页。

---

## 卸载

```powershell
# 1. 从 profile\package.json 的 dependencies 里删掉 @dsh-plugin/mobile-remote
# 2. 重新装一次依赖
cd "$env:USERPROFILE\.dsh\profiles\desktop"
& "D:\Software\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\pnpm.cmd" install

# 3. 删掉 cordis.patch.yml 里 mobile-remote 那几行
# 4. 重启 DSH
```

配对记录、身份、日志留在 `%USERPROFILE%\.dsh\dsh-mobile-remote\`，要彻底清掉就整个删掉。

注意：卸载后**服务器上的端口登记仍然保留**（7 天不露面才回收），重装回来通常还是原来那个端口，手机上不用重新扫。

---

## 开发者：从本地目录装

改代码调试时不想每次都推 GitHub，可以让 profile 直接指向本地目录：

```powershell
$plugin  = "D:\path\to\dsh-mobile-remote"
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"

New-Item -ItemType Directory -Force -Path "$profile\node_modules\@dsh-plugin" | Out-Null
cmd /c mklink /J "$profile\node_modules\@dsh-plugin\mobile-remote" "$plugin"
```

然后 `dependencies` 里写 `"@dsh-plugin/mobile-remote": "link:./node_modules/@dsh-plugin/mobile-remote"`，或者干脆把这个包从 `package.json` 里去掉——`cordis.patch.yml` 的 `name` 能按包名解析到 `node_modules` 里的 junction，`main` 字段会指到 `lib/index.js`。

junction 不需要管理员权限。改完 `lib/*.js` 约 2 秒自动重载（`autoReload` 默认开），改 `web/*` 刷新页面即生效。
