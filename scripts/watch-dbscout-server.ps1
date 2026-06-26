$ErrorActionPreference = "Stop"

$ensureScript = Join-Path $PSScriptRoot "ensure-dbscout-server.ps1"
$watchdogLog = Join-Path (Split-Path -Parent $PSScriptRoot) ".dbscout-server-watchdog.log"
$mutexName = "Local\DBScoutServerWatchdog"
$intervalSeconds = 60

function Write-WatchdogLog {
    param([string]$Message)

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $watchdogLog -Value "[$timestamp] $Message"
}

$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$hasLock = $false

try {
    $hasLock = $mutex.WaitOne(0)
    if (-not $hasLock) {
        exit 0
    }

    Write-WatchdogLog "watchdog loop started"

    while ($true) {
        try {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ensureScript | Out-Null
        } catch {
            Write-WatchdogLog "ensure failed: $($_.Exception.Message)"
        }

        Start-Sleep -Seconds $intervalSeconds
    }
} finally {
    if ($hasLock) {
        $mutex.ReleaseMutex() | Out-Null
    }
    $mutex.Dispose()
}
