# Keep a Cloudflare quick tunnel up for the phone plugin (no inbound port needed).
# - starts cloudflared if it is not running
# - reads the current https://*.trycloudflare.com URL from its log
# - writes it to %LOCALAPPDATA%\cloudflared\url.txt, which the plugin reads for the QR code
# - optionally registers a logon task + 10 minute watchdog (-InstallTask)
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.
[CmdletBinding()]
param(
  [string]$Dir = (Join-Path $env:LOCALAPPDATA 'cloudflared'),
  [string]$LocalUrl = 'http://127.0.0.1:7788',
  [switch]$InstallTask,
  [switch]$Supervise,
  [int]$IntervalSeconds = 45
)

$ErrorActionPreference = 'Stop'
$exe = Join-Path $Dir 'cloudflared.exe'
$log = Join-Path $Dir 'tunnel.log'
$urlFile = Join-Path $Dir 'url.txt'

if (-not (Test-Path $exe)) { throw "cloudflared.exe not found at $exe" }
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

function Get-TunnelUrl {
  if (-not (Test-Path $log)) { return $null }
  $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches -ErrorAction SilentlyContinue
  if (-not $m) { return $null }
  return $m.Matches[-1].Value
}

$proc = Get-Process cloudflared -ErrorAction SilentlyContinue
if (-not $proc) {
  Write-Host '[tunnel] starting cloudflared...'
  Start-Process -FilePath $exe -ArgumentList @('tunnel','--url',$LocalUrl,'--no-autoupdate','--logfile',$log,'--loglevel','info') -WorkingDirectory $Dir -WindowStyle Hidden
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    if (Get-TunnelUrl) { break }
  }
  $proc = Get-Process cloudflared -ErrorAction SilentlyContinue
} else {
  Write-Host ("[tunnel] cloudflared already running (pid " + $proc.Id + ")")
}

$url = Get-TunnelUrl
if (-not $url) { Write-Host '[tunnel] no public URL in the log yet, check the log below'; Get-Content $log -Tail 20; exit 1 }

Set-Content -Path $urlFile -Value $url -Encoding ASCII
Write-Host "[tunnel] public URL: $url"
Write-Host "[tunnel] written to $urlFile (the plugin reads this for the QR code)"

if ($Supervise) {
  # Long-running watchdog: the quick tunnel dies now and then (laptop sleep, network
  # change, cloudflared crash). Without a supervisor the phone gets Cloudflare 1033.
  # This loop keeps a process alive and re-writes url.txt whenever the URL changes.
  Write-Host ("[tunnel] supervising (check every " + $IntervalSeconds + "s), Ctrl+C to stop")
  $last = $url
  while ($true) {
    Start-Sleep -Seconds $IntervalSeconds
    $alive = Get-Process cloudflared -ErrorAction SilentlyContinue
    if (-not $alive) {
      Write-Host ('[tunnel] cloudflared is gone, restarting at ' + (Get-Date -Format 'HH:mm:ss'))
      # A fresh start gets a fresh hostname, so keep the old log out of the way.
      if (Test-Path $log) { Move-Item -Path $log -Destination ($log + '.old') -Force -ErrorAction SilentlyContinue }
    }
    try {
      if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
        Start-Process -FilePath $exe -ArgumentList @('tunnel','--url',$LocalUrl,'--no-autoupdate','--logfile',$log,'--loglevel','info') -WorkingDirectory $Dir -WindowStyle Hidden
      }
      $now = Get-TunnelUrl
      if ($now -and $now -ne $last) {
        Set-Content -Path $urlFile -Value $now -Encoding ASCII
        $last = $now
        Write-Host ('[tunnel] new public URL: ' + $now)
      }
    } catch {
      Write-Host ('[tunnel] supervise tick failed: ' + $_.Exception.Message)
    }
  }
}

if ($InstallTask) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $self = $MyInvocation.MyCommand.Path
    $arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $self + '"'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
    $start = (Get-Date).AddMinutes(1)
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $watch = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName 'dsh-cloudflared' -Action $action -Trigger @($trigger, $watch) -Settings $settings -Description 'Keep the DSH phone tunnel (cloudflared) alive' -Force | Out-Null
    Write-Host '[tunnel] scheduled task dsh-cloudflared installed (logon + every 10 minutes)'
  } catch {
    Write-Host ('[tunnel] could not install the scheduled task: ' + $_.Exception.Message)
  }
  $ErrorActionPreference = $prev
}
