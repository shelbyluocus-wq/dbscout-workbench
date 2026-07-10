[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "stop", "status")]
    [string]$Action = "start"
)

$ErrorActionPreference = "Stop"

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$FixtureRoot = [IO.Path]::GetFullPath((Join-Path $RepoRoot "target\perf-mysql"))
$DataDirectory = [IO.Path]::GetFullPath((Join-Path $FixtureRoot "data"))
$PidFile = Join-Path $FixtureRoot "mysqld.pid"
$ErrorLog = Join-Path $FixtureRoot "mysqld-error.log"
$ManifestPath = Join-Path $RepoRoot "output\performance\mysql-fixture.json"

function Normalize-Path([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Assert-FixturePath([string]$Path, [string]$Expected, [string]$Label) {
    $normalized = Normalize-Path $Path
    $expectedNormalized = Normalize-Path $Expected
    $repoPrefix = (Normalize-Path $RepoRoot) + [IO.Path]::DirectorySeparatorChar
    if ($normalized -ne $expectedNormalized -or -not $normalized.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label is outside the verified fixture location: $normalized"
    }
}

function Find-MySqlD {
    $candidates = [Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($env:DBSCOUT_MYSQLD_PATH)) {
        $candidates.Add($env:DBSCOUT_MYSQLD_PATH)
    }
    $command = Get-Command mysqld.exe -ErrorAction SilentlyContinue
    if ($command) {
        $candidates.Add($command.Source)
    }
    $candidates.Add("C:\Program Files\MySQL\MySQL Server 5.7\bin\mysqld.exe")

    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            continue
        }
        $resolved = (Resolve-Path -LiteralPath $candidate).Path
        $versionText = (& $resolved --version 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $versionText -match "Ver 5\.7\.") {
            return [pscustomobject]@{
                Path = $resolved
                Version = $versionText
            }
        }
    }
    throw "MySQL 5.7 mysqld.exe was not found. Set DBSCOUT_MYSQLD_PATH to the exact executable."
}

function Get-FreeTcpPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    }
    finally {
        $listener.Stop()
    }
}

function Invoke-MySqlAdmin([string]$Executable, [int]$Port, [string]$Command) {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $Executable --no-defaults --protocol=tcp --host=127.0.0.1 --port=$Port --user=root $Command 2>$null | Out-Null
        return $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Read-Manifest {
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        throw "Fixture manifest does not exist: $ManifestPath"
    }
    return Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
}

function Get-VerifiedFixtureProcess($Manifest, [switch]$AllowMissing) {
    Assert-FixturePath $Manifest.fixtureRoot $FixtureRoot "fixtureRoot"
    Assert-FixturePath $Manifest.dataDirectory $DataDirectory "dataDirectory"
    $expectedExecutable = Normalize-Path $Manifest.mysqldPath
    if ($Manifest.pid -notmatch "^\d+$") {
        throw "Fixture manifest contains an invalid PID"
    }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($Manifest.pid)" -ErrorAction SilentlyContinue
    if (-not $process) {
        if ($AllowMissing) {
            return $null
        }
        throw "Fixture process $($Manifest.pid) is not running"
    }
    if ((Normalize-Path $process.ExecutablePath) -ne $expectedExecutable) {
        throw "PID $($Manifest.pid) does not belong to the fixture mysqld executable"
    }
    if ([string]::IsNullOrWhiteSpace($process.CommandLine) -or
        $process.CommandLine.IndexOf($DataDirectory, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "PID $($Manifest.pid) does not use the verified fixture data directory"
    }
    return $process
}

function Stop-Fixture {
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        if (Test-Path -LiteralPath $FixtureRoot) {
            throw "Fixture directory exists without a manifest; refusing to delete it: $FixtureRoot"
        }
        Write-Output "MySQL fixture is already stopped."
        return
    }

    $manifest = Read-Manifest
    $process = Get-VerifiedFixtureProcess $manifest -AllowMissing
    if ($process) {
        $mysqlAdmin = Join-Path (Split-Path -Parent $manifest.mysqldPath) "mysqladmin.exe"
        if (Test-Path -LiteralPath $mysqlAdmin -PathType Leaf) {
            $null = Invoke-MySqlAdmin $mysqlAdmin $manifest.port "shutdown"
        }
        try {
            Wait-Process -Id $manifest.pid -Timeout 10 -ErrorAction Stop
        }
        catch {
            $verifiedAgain = Get-VerifiedFixtureProcess $manifest -AllowMissing
            if ($verifiedAgain) {
                Stop-Process -Id $manifest.pid -Force
                Wait-Process -Id $manifest.pid -Timeout 10 -ErrorAction SilentlyContinue
            }
        }
        if (Get-CimInstance Win32_Process -Filter "ProcessId = $($manifest.pid)" -ErrorAction SilentlyContinue) {
            throw "Fixture process $($manifest.pid) did not stop"
        }
    }

    Assert-FixturePath $FixtureRoot $FixtureRoot "fixtureRoot"
    if (Test-Path -LiteralPath $FixtureRoot) {
        Remove-Item -LiteralPath $FixtureRoot -Recurse -Force
    }
    Remove-Item -LiteralPath $ManifestPath -Force
    Write-Output "MySQL fixture stopped and verified fixture files removed."
}

function Start-Fixture {
    if (Test-Path -LiteralPath $ManifestPath -PathType Leaf) {
        $existing = Read-Manifest
        $process = Get-VerifiedFixtureProcess $existing -AllowMissing
        if ($process) {
            Write-Output "MySQL fixture is already running on port $($existing.port) (PID $($existing.pid))."
            return
        }
        Stop-Fixture
    }
    elseif (Test-Path -LiteralPath $FixtureRoot) {
        throw "Fixture directory exists without a manifest; refusing to replace it: $FixtureRoot"
    }

    $server = Find-MySqlD
    $baseDirectory = Split-Path -Parent (Split-Path -Parent $server.Path)
    $port = Get-FreeTcpPort
    New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path (Split-Path -Parent $ManifestPath) -Force | Out-Null

    $initializeArguments = @(
        "--no-defaults",
        "--initialize-insecure",
        "--basedir=$baseDirectory",
        "--datadir=$DataDirectory"
    )
    & $server.Path @initializeArguments 2>&1 | Out-File -LiteralPath $ErrorLog -Encoding utf8
    if ($LASTEXITCODE -ne 0) {
        throw "MySQL fixture initialization failed with exit code $LASTEXITCODE. See $ErrorLog"
    }

    $quotedBase = '--basedir="' + $baseDirectory + '"'
    $quotedData = '--datadir="' + $DataDirectory + '"'
    $quotedPid = '--pid-file="' + $PidFile + '"'
    $quotedLog = '--log-error="' + $ErrorLog + '"'
    $started = $null
    try {
        $serverArguments = @(
            "--no-defaults",
            $quotedBase,
            $quotedData,
            "--port=$port",
            "--bind-address=127.0.0.1",
            $quotedPid,
            $quotedLog,
            "--skip-name-resolve",
            "--skip-grant-tables",
            "--character-set-server=utf8mb4",
            "--collation-server=utf8mb4_unicode_ci"
        )
        $started = Start-Process -FilePath $server.Path -ArgumentList $serverArguments -PassThru -WindowStyle Hidden
        $mysqlAdmin = Join-Path (Split-Path -Parent $server.Path) "mysqladmin.exe"

        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        $ready = $false
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($started.HasExited) {
                throw "MySQL fixture exited during startup with code $($started.ExitCode). See $ErrorLog"
            }
            if ((Invoke-MySqlAdmin $mysqlAdmin $port "ping") -eq 0) {
                $ready = $true
                break
            }
            Start-Sleep -Milliseconds 200
            $started.Refresh()
        }
        if (-not $ready) {
            throw "MySQL fixture did not become ready within 45 seconds. See $ErrorLog"
        }

        $pidFromFile = [int](Get-Content -LiteralPath $PidFile -Raw).Trim()
        if ($pidFromFile -ne $started.Id) {
            throw "MySQL fixture PID file does not match the process started by this script"
        }

        $manifest = [ordered]@{
            schemaVersion = "1.0.0"
            serverVersion = $server.Version
            pid = $started.Id
            port = $port
            host = "127.0.0.1"
            username = "root"
            url = "mysql://root@127.0.0.1:$port"
            mysqldPath = $server.Path
            fixtureRoot = $FixtureRoot
            dataDirectory = $DataDirectory
            startedAtUtc = [DateTime]::UtcNow.ToString("o")
        }
        $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ManifestPath -Encoding utf8
        $null = Get-VerifiedFixtureProcess $manifest
        Write-Output "MySQL fixture ready on port $port (PID $($started.Id))."
    }
    catch {
        if ($started -and -not $started.HasExited) {
            $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($started.Id)" -ErrorAction SilentlyContinue
            if ($candidate -and
                (Normalize-Path $candidate.ExecutablePath) -eq (Normalize-Path $server.Path) -and
                $candidate.CommandLine.IndexOf($DataDirectory, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                Stop-Process -Id $started.Id -Force
                Wait-Process -Id $started.Id -Timeout 10 -ErrorAction SilentlyContinue
            }
        }
        Assert-FixturePath $FixtureRoot $FixtureRoot "fixtureRoot"
        if (Test-Path -LiteralPath $FixtureRoot) {
            Remove-Item -LiteralPath $FixtureRoot -Recurse -Force
        }
        if (Test-Path -LiteralPath $ManifestPath -PathType Leaf) {
            Remove-Item -LiteralPath $ManifestPath -Force
        }
        throw
    }
}

switch ($Action) {
    "start" { Start-Fixture }
    "stop" { Stop-Fixture }
    "status" {
        $manifest = Read-Manifest
        $null = Get-VerifiedFixtureProcess $manifest
        $manifest | ConvertTo-Json -Depth 4
    }
}
