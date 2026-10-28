# DSH Mobile Remote 安装器
#
# 目标：一台**全新的** DeepSeek Harness，双击这个 exe 就能用手机接管，
# 不需要 git、不需要 pnpm、不需要管理员权限、不需要手工 mklink。
#
# 做法（全部在用户目录内完成）：
#   1. 把插件本体复制到 %LOCALAPPDATA%\DSH-Mobile\app
#      —— 放进用户目录而不是原地运行，是因为 SFX 会把内容解到临时目录，
#         临时目录随时会被清掉，插件必须有个稳定的家。
#   2. 在选中的 profile 下建 junction：node_modules\@local\dsh-mobile-remote → app
#      —— junction 不需要管理员权限（symbolic link 才需要）。
#   3. 往 profile 的 cordis.patch.yml 里插入一条 bundle 配置（幂等）。
#   4. 自检：frpc.exe / lib / web / 二维码编码器 是否都在。
#
# 反复运行是安全的：已存在的目录会被覆盖更新，patch 里已有的条目不会重复插入。

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Fail($msg) { Write-Host "错误：$msg" -ForegroundColor Red; exit 1 }

$src = $PSScriptRoot
if (-not (Test-Path (Join-Path $src 'lib\index.js'))) { Fail "解压目录不完整：$src" }

# ---------- 1. 选 profile ----------
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profRoot = Join-Path $dshHome 'profiles'
if (-not (Test-Path $profRoot)) {
  Fail "没找到 $profRoot。请先打开一次 DeepSeek Harness（它会在首次启动时创建 profile），然后重新运行本安装器。"
}

$profiles = Get-ChildItem -Path $profRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'package.json') }

if (-not $profiles) {
  Fail "在 $profRoot 下没有找到任何 profile。请先打开一次 DeepSeek Harness，再重新运行。"
}

$profileDir = $null
if ($profiles.Count -eq 1) {
  $profileDir = $profiles[0].FullName
  Say "使用 profile：$($profiles[0].Name)"
} else {
  Say '检测到多个 profile：' Cyan
  for ($i = 0; $i -lt $profiles.Count; $i++) { Say ("  [{0}] {1}" -f ($i + 1), $profiles[$i].Name) }
  $pick = Read-Host '要装进哪一个？（输入序号，直接回车 = 1）'
  if ([string]::IsNullOrWhiteSpace($pick)) { $pick = '1' }
  $idx = 0
  if (-not [int]::TryParse($pick, [ref]$idx) -or $idx -lt 1 -or $idx -gt $profiles.Count) { Fail '序号不对。' }
  $profileDir = $profiles[$idx - 1].FullName
}

# ---------- 2. 复制到稳定位置 ----------
$appDir = Join-Path $env:LOCALAPPDATA 'DSH-Mobile\app'
Say "安装到：$appDir"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

# 只覆盖不需要保留的东西；identity.json / frpc.toml 这类运行态在 .dsh 下，不在 app 里，所以放心的覆盖。
foreach ($name in @('lib', 'web', 'locale', 'deploy')) {
  $from = Join-Path $src $name
  if (-not (Test-Path $from)) { continue }
  $to = Join-Path $appDir $name
  if (Test-Path $to) { Remove-Item -Recurse -Force $to }
  Copy-Item -Recurse -Force $from $to
}
foreach ($file in @('package.json', 'cordis.patch.yml', 'icon.svg', 'README.md', 'INSTALL.md', 'LICENSE')) {
  $from = Join-Path $src $file
  if (Test-Path $from) { Copy-Item -Force $from (Join-Path $appDir $file) }
}

# ---------- 3. 建 junction ----------
$scopeDir = Join-Path $profileDir 'node_modules\@local'
New-Item -ItemType Directory -Force -Path $scopeDir | Out-Null
$link = Join-Path $scopeDir 'dsh-mobile-remote'

if (Test-Path $link) {
  $item = Get-Item $link -Force
  $isLink = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  if ($isLink) {
    # 已指向别处（比如用户自己的 clone）：先摘掉，再指向我们的稳定目录。
    $target = $item.Target
    if ($target -is [array]) { $target = $target[0] }
    if ($target -and ($target -ne $appDir)) {
      Say "原来指向：$target，改为指向 $appDir" Yellow
      cmd /c rmdir "$link" | Out-Null
    }
  } else {
    Say "$link 是一个真实目录（不是 junction），先备份再替换" Yellow
    $bak = "$link.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Move-Item $link $bak
    Say "原目录已备份到 $bak"
  }
}
if (-not (Test-Path $link)) {
  cmd /c mklink /J "$link" "$appDir" | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $link)) { Fail "建 junction 失败：$link -> $appDir" }
  Say "已挂到 profile：@local/dsh-mobile-remote"
} else {
  Say 'junction 已存在且指向正确'
}

# ---------- 4. 写 cordis.patch.yml ----------
#
# profile 的 patch 是一层**顶层 YAML 数组**，每一项要么是
#   - id: <已有插件 id>      ← 改配置/禁用，按 id 命中
#   - insert: [...]          ← 往某个组里插新插件
# 我们装的是一个全新插件，所以用 insert。但 insert 有好几种落法：
#   (a) 数组里没有 insert 项      → 直接追加一条 `- insert: [ ... ]`
#   (b) 已有 insert 项            → 往那个列表末尾追加我们的条目
# 这里只处理 (a)：新建一条 insert。已经存在就整段跳过。
# 之所以不硬塞进别人的 insert 里，是因为那需要真正解析 YAML，
# 而出问题时用户完全看不懂——宁可多一条独立的 insert 项，语义也更清楚。
$patch = Join-Path $profileDir 'cordis.patch.yml'
$block = @(
  '- insert:',
  '    - id: mobile-remote',
  "      name: '@local/dsh-mobile-remote'",
  '      config:',
  "        host: '127.0.0.1'",
  '        port: 7788'
) -join "`r`n"

$text = ''
if (Test-Path $patch) { $text = Get-Content -Raw -Path $patch -Encoding UTF8 }
if ($text -match 'dsh-mobile-remote') {
  Say 'cordis.patch.yml 里已有 mobile-remote，跳过'
} else {
  if ([string]::IsNullOrWhiteSpace($text)) {
    # 全新 profile：连注释头都还没有，给一行说明，免得用户打开是一团空白。
    $text = "# Your patch layer for this dsh profile, applied after every bundle layer.`r`n"
  }
  $text = $text.TrimEnd() + "`r`n" + $block + "`r`n"
  [IO.File]::WriteAllText($patch, $text, (New-Object Text.UTF8Encoding($false)))
  Say "已写入 bundle 配置：$patch"
}

# ---------- 5. 自检 ----------
Say ''
Say '自检：' Cyan
$ok = $true
function Check($label, $path) {
  if (Test-Path $path) {
    $size = (Get-Item $path).Length
    Say ("  [OK]   {0}  ({1:N0} 字节)" -f $label, $size) 'Green'
  } else {
    Say ("  [缺失] {0}  {1}" -f $label, $path) 'Red'
    $script:ok = $false
  }
}
Check '宿主入口'   (Join-Path $appDir 'lib\index.js')
Check '二维码编码器' (Join-Path $appDir 'lib\qr.js')
Check '手机端外壳'  (Join-Path $appDir 'web\app.js')
Check '管理页'     (Join-Path $appDir 'web\admin.html')
Check '配对浮层'   (Join-Path $appDir 'web\pair-panel.js')
Check 'frpc 隧道'  (Join-Path $appDir 'deploy\pc\frpc.exe')

$pluginExe = Join-Path $appDir 'deploy\pc\frpc.exe'
if (Test-Path $pluginExe) {
  $mb = (Get-Item $pluginExe).Length / 1MB
  if ($mb -lt 1) { Say '  [警告] frpc.exe 太小，可能是个占位文件' 'Yellow'; $ok = $false }
}

Say ''
if ($ok) {
  Say '安装完成。' 'Green'
  Say '接下来：' Cyan
  Say '  1. 重启 DeepSeek Harness'
  Say '  2. 打开 http://127.0.0.1:7788/admin 扫码绑定手机'
  Say '     （也可以点 DSH 侧边栏底部的手机图标）'
} else {
  Say '安装不完整，请看上面标红的项。' 'Red'
  exit 1
}
