param(
    [string]$OutputDir = "",
    [switch]$LeaveRunning
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$sourceDb = Join-Path $root "dbscout-server.sqlite"
$sourceWal = "$sourceDb-wal"
$sourceShm = "$sourceDb-shm"

if (-not (Test-Path -LiteralPath $sourceDb)) {
    throw "未找到中心服务数据库: $sourceDb"
}

if (-not $LeaveRunning) {
    Write-Host "1/3 正在停止旧机上的看门狗与 dbscout-server 进程，确保 WAL 数据完全落盘..."
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.Name -match "powershell|pwsh|wscript") -and
            ($_.CommandLine -match "watch-dbscout-server|ensure-dbscout-server")
        } |
        ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {}
        }

    Get-Process -Name "dbscout-server" -ErrorAction SilentlyContinue |
        ForEach-Object {
            try { Stop-Process -Id $_.Id -ErrorAction Stop } catch {}
        }

    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Get-Process -Name "dbscout-server" -ErrorAction SilentlyContinue)) {
            break
        }
        Start-Sleep -Milliseconds 300
    }
    if (Get-Process -Name "dbscout-server" -ErrorAction SilentlyContinue) {
        Get-Process -Name "dbscout-server" -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Milliseconds 500
    }
} else {
    Write-Warning "已启用 -LeaveRunning：如果服务仍在写入，请确保 WAL 已合并，否则可能丢失最近几条记录。"
}

if ((Test-Path -LiteralPath $sourceWal) -and ((Get-Item -LiteralPath $sourceWal).Length -gt 0)) {
    throw "检测到非空 WAL 文件 ($sourceWal)。请先确认 dbscout-server 已彻底退出并正常落盘，或用 sqlite3 执行 PRAGMA wal_checkpoint(TRUNCATE) 后再导出。"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $root "output\server-migration-$stamp"
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$targetDb = Join-Path $OutputDir "dbscout-server.sqlite"
Copy-Item -LiteralPath $sourceDb -Destination $targetDb -Force

$sizeKb = [Math]::Round((Get-Item -LiteralPath $targetDb).Length / 1024, 1)
Write-Host "2/3 已导出干净的中心库文件: $targetDb ($sizeKb KB)"
Write-Host "3/3 下一步可将此文件传到 192.168.1.243："
Write-Host "    node scripts/deploy-blackcat-server.mjs --migrate-db `"$targetDb`""
