# Reload the mobile-remote plugin WITHOUT restarting DSH.
#
# The host's HMR gets stuck forever after "HMR transactions cannot be nested"
# (only a process restart clears it), so the plugin ships its own reload path:
# it shuts itself down (unsubscribe, close 7788, clear timers) and then
# re-imports lib/index.js with ?v=<timestamp> and applies it again.
#
# Usage:
#   .\tools\reload.ps1
#   .\tools\reload.ps1 -Wait 2 -Port 7788
#
# NOTE: ASCII only on purpose - Windows PowerShell 5.1 decodes BOM-less UTF-8
# files as ANSI and would corrupt non-ASCII text.

param(
    [double]$Wait = 1.5,
    [int]$Port = 7788
)

$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:$Port"

$before = Invoke-RestMethod "$base/api/health"
Write-Host ("before : rev=" + $before.rev + " devices=" + $before.devices)

try {
    $response = Invoke-RestMethod "$base/api/dev/reload" -Method Post -TimeoutSec 10
    Write-Host ("reload : accepted rev=" + $response.rev)
} catch {
    Write-Host "reload : FAILED -> $($_.Exception.Message)"
    Write-Host "         The running build has no /api/dev/reload yet. Restart DSH once."
    exit 1
}

Start-Sleep -Seconds $Wait

for ($i = 0; $i -lt 10; $i++) {
    try {
        $after = Invoke-RestMethod "$base/api/health"
        Write-Host ("after  : rev=" + $after.rev + " devices=" + $after.devices + " uptimeMs=" + $after.uptimeMs)
        break
    } catch {
        Start-Sleep -Milliseconds 300
    }
}
