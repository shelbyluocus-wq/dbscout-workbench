$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$serverExe = Join-Path $root "target\debug\dbscout-server.exe"
$dbPath = Join-Path $root "dbscout-server.sqlite"
$watchdogLog = Join-Path $root ".dbscout-server-watchdog.log"
$serverOutLog = Join-Path $root ".dbscout-server.out.log"
$serverErrLog = Join-Path $root ".dbscout-server.err.log"
$bindAddress = "0.0.0.0:8765"
$listenPort = 8765

function Write-WatchdogLog {
    param([string]$Message)

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $watchdogLog -Value "[$timestamp] $Message"
}

function Test-ServerListening {
    try {
        $listener = Get-NetTCPConnection -LocalPort $listenPort -State Listen -ErrorAction Stop |
            Select-Object -First 1
        return $null -ne $listener
    } catch {
        $netstat = & netstat -ano | Select-String -Pattern "LISTENING\s+\d+$" |
            Where-Object { $_.Line -match ":(?:$listenPort)\s+" } |
            Select-Object -First 1
        return $null -ne $netstat
    }
}

if (-not (Test-Path -LiteralPath $serverExe)) {
    Write-WatchdogLog "server executable missing: $serverExe"
    exit 2
}

if (Test-ServerListening) {
    exit 0
}

$env:DBSCOUT_SERVER_BIND = $bindAddress
$env:DBSCOUT_SERVER_DB = $dbPath

Start-Process `
    -FilePath $serverExe `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $serverOutLog `
    -RedirectStandardError $serverErrLog

Start-Sleep -Seconds 2

if (Test-ServerListening) {
    Write-WatchdogLog "started dbscout-server on $bindAddress with db $dbPath"
    exit 0
}

Write-WatchdogLog "attempted start, but port $listenPort is still not listening"
exit 1
