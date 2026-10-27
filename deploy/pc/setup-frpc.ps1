# Install frpc on this Windows PC: download -> write config -> register logon task -> start now.
#   powershell -ExecutionPolicy Bypass -File .\setup-frpc.ps1 -Token "<token printed by setup-frps.sh>"
# NOTE: this file is intentionally ASCII-only so it parses correctly in Windows PowerShell 5.1
#       (5.1 reads BOM-less files as ANSI and would mangle any non-ASCII text).
[CmdletBinding()]
param(
  [string]$Server = '8.152.5.127',
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Version = '0.62.1',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'frp')
)

$ErrorActionPreference = 'Stop'
function Say($m) { Write-Host "[frpc] $m" -ForegroundColor Cyan }
function Die($m) { Write-Host "[frpc] $m" -ForegroundColor Red; exit 1 }

if (-not [Environment]::Is64BitOperatingSystem) { Die '64-bit Windows required' }
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$exe = Join-Path $InstallDir 'frpc.exe'
$conf = Join-Path $InstallDir 'frpc.toml'

if (-not (Test-Path $exe)) {
  $zip = "frp_${Version}_windows_amd64.zip"
  $tmp = Join-Path $env:TEMP $zip
  $urls = @(
    "https://github.com/fatedier/frp/releases/download/v$Version/$zip",
    "https://ghfast.top/https://github.com/fatedier/frp/releases/download/v$Version/$zip",
    "https://gh-proxy.com/https://github.com/fatedier/frp/releases/download/v$Version/$zip"
  )
  $ok = $false
  foreach ($u in $urls) {
    Say "downloading $u"
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -Uri $u -OutFile $tmp -TimeoutSec 180 -UseBasicParsing
      $ok = $true; break
    } catch { Say "failed: $($_.Exception.Message)" }
  }
  if (-not $ok) { Die "download failed. Get $zip manually and put frpc.exe into $InstallDir" }
  $unzip = Join-Path $env:TEMP 'frp-unpack'
  Remove-Item -Recurse -Force $unzip -ErrorAction SilentlyContinue
  Expand-Archive -Path $tmp -DestinationPath $unzip -Force
  $found = Get-ChildItem -Path $unzip -Recurse -Filter 'frpc.exe' | Select-Object -First 1
  if (-not $found) { Die 'frpc.exe not found inside the archive' }
  Copy-Item $found.FullName $exe -Force
  Say ("installed " + (& $exe --version))
}

$template = Join-Path $PSScriptRoot 'frpc.toml'
if (-not (Test-Path $template)) { Die "template not found: $template" }
$text = Get-Content $template -Raw -Encoding UTF8
$text = $text.Replace('REPLACE_WITH_LONG_RANDOM_TOKEN', $Token)
$text = $text.Replace('serverAddr = "8.152.5.127"', ('serverAddr = "' + $Server + '"'))
[System.IO.File]::WriteAllText($conf, $text, (New-Object System.Text.UTF8Encoding($false)))
Say "config written: $conf"

$taskName = 'dsh-frpc'
# Windows PowerShell 5.1 turns any native stderr output into a terminating error when
# $ErrorActionPreference = 'Stop', so avoid raw schtasks.exe calls with nested quotes.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$autostart = 'none'
try {
  $action = New-ScheduledTaskAction -Execute $exe -Argument ('-c "' + $conf + '"') -WorkingDirectory $InstallDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User ($env:USERDOMAIN + '\' + $env:USERNAME)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Keep the DSH mobile tunnel (frpc) running' -Force | Out-Null
  $autostart = 'scheduled-task'
} catch {
  Say ('scheduled task failed: ' + $_.Exception.Message)
  try {
    $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'dsh-frpc.lnk'
    $sh = New-Object -ComObject WScript.Shell
    $s = $sh.CreateShortcut($lnk)
    $s.TargetPath = $exe
    $s.Arguments = '-c "' + $conf + '"'
    $s.WorkingDirectory = $InstallDir
    $s.WindowStyle = 7
    $s.Save()
    $autostart = 'startup-shortcut'
  } catch {
    Say ('startup shortcut failed: ' + $_.Exception.Message)
  }
}
if ($autostart -eq 'none') { Say 'autostart not configured (run the script again or start frpc manually)' }
else { Say "autostart configured: $autostart" }
$ErrorActionPreference = $prevEap

Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Start-Process -FilePath $exe -ArgumentList @('-c', $conf) -WorkingDirectory $InstallDir -WindowStyle Hidden
Start-Sleep -Seconds 3

$alive = Get-Process frpc -ErrorAction SilentlyContinue
if (-not $alive) { Die "frpc did not start, check $InstallDir\frpc.log" }
Say 'frpc is running, probing server ports...'

foreach ($port in 7000, 7788) {
  $c = New-Object Net.Sockets.TcpClient
  try {
    $r = $c.BeginConnect($Server, $port, $null, $null)
    if ($r.AsyncWaitHandle.WaitOne(2000) -and $c.Connected) { Say "  server port $port OK" }
    else { Say "  server port $port unreachable (security group? frps down?)" }
  } catch {
    Say "  server port ${port}: $($_.Exception.Message)"
  } finally { $c.Close() }
}

Say 'done. Open http://127.0.0.1:7788/admin on this PC to generate the QR code.'
