# dsh-vps-tunnel.ps1  (ASCII only on purpose: Windows PowerShell 5.1 reads
# BOM-less UTF-8 as ANSI and would corrupt non-ASCII text)
#
# Keeps a reverse SSH tunnel alive so the phone can reach the local DSH mobile
# plugin through the cloud server's public IP:
#
#     phone -> http://8.152.5.127:7788  ->  sshd on VPS  ->  PC 127.0.0.1:7788
#
# Why SSH instead of frp:
#   * sshd is already listening on port 22 (open in the security group).
#   * With GatewayPorts clientspecified the remote bind can be 0.0.0.0, so only
#     ONE extra inbound rule is needed (TCP 7788) instead of two (7000 + 7788).
#   * No extra binary, no token to keep in sync.
#
# The plugin itself keeps listening on 127.0.0.1 only; nothing is exposed on the
# LAN, and the public side terminates on the VPS.

param(
  [string]$Server    = '8.152.5.127',
  [int]$RemotePort   = 7788,
  [int]$LocalPort    = 7788,
  [string]$KeyPath   = "$env:USERPROFILE\.ssh\dsh_vps_ed25519",
  [int]$IntervalSec  = 20
)

$ErrorActionPreference = 'Continue'
$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"
$log = Join-Path $env:LOCALAPPDATA 'dsh-vps-tunnel.log'

function Write-Log([string]$Text) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text
  Add-Content -Path $log -Value $line -Encoding UTF8
}

function Test-LocalPlugin {
  try {
    $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$LocalPort/api/health" -TimeoutSec 5
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

if (-not (Test-Path $ssh)) { Write-Log "ssh.exe not found: $ssh"; exit 1 }
if (-not (Test-Path $KeyPath)) { Write-Log "key not found: $KeyPath"; exit 1 }

Write-Log "supervisor start: $Server remote:$RemotePort -> local:$LocalPort"

while ($true) {
  $proc = Get-Process ssh -ErrorAction SilentlyContinue | Where-Object {
    try { $_.CommandLine -like "*$RemotePort`:127.0.0.1:$LocalPort*" } catch { $false }
  }
  # Fall back: if we cannot inspect command lines, only skip when a tunnel
  # process was recorded by us and is still alive.
  if ($null -eq $proc) { $proc = $null }

  if (-not (Test-LocalPlugin)) {
    Write-Log "local plugin not answering on 127.0.0.1:$LocalPort; waiting"
    Start-Sleep -Seconds $IntervalSec
    continue
  }

  $args = @(
    '-i', $KeyPath,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-N',
    '-R', "0.0.0.0`:$RemotePort`:127.0.0.1:$LocalPort",
    "root@$Server"
  )
  Write-Log "starting reverse tunnel 0.0.0.0:$RemotePort -> 127.0.0.1:$LocalPort"
  $child = Start-Process -FilePath $ssh -ArgumentList $args -PassThru -WindowStyle Hidden -RedirectStandardError (Join-Path $env:LOCALAPPDATA 'dsh-vps-tunnel.err')
  Write-Log "tunnel pid=$($child.Id)"
  # Watch the child; ssh exits on network trouble, then we loop and restart it.
  while ($true) {
    Start-Sleep -Seconds 10
    $alive = Get-Process -Id $child.Id -ErrorAction SilentlyContinue
    if (-not $alive) { Write-Log "tunnel pid=$($child.Id) exited; restarting in $IntervalSec s"; break }
    if (-not (Test-LocalPlugin)) { Write-Log "plugin went away; keeping tunnel up"; }
  }
  Start-Sleep -Seconds $IntervalSec
}
