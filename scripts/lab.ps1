param([ValidateSet('Prepare','Backend','A','B','Stop','Clean','Status')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$labRoot = Join-Path $workspace '.nexus-lab'
$pgBin = Join-Path $workspace '.postgres\pgsql\bin'
$stateFile = Join-Path $labRoot 'processes.json'

. (Join-Path $PSScriptRoot 'lab-common.ps1')
function Read-State {
    if (Test-Path -LiteralPath $stateFile) {
        $decoded = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        foreach ($record in $decoded) { Write-Output $record }
        return
    }
    return @()
}
function Match-Process($record) {
    $process = Get-Process -Id $record.Id -ErrorAction SilentlyContinue
    if ($process -and $process.Path -eq $record.Path -and $process.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.Start) { return $process }
    return $null
}
function Save-Process($process, $role) {
    for ($attempt=0; $attempt -lt 20; $attempt++) {
        $process = Get-Process -Id $process.Id -ErrorAction Stop
        if ($process.Path) { break }
        Start-Sleep -Milliseconds 100
    }
    if (-not $process.Path) { throw "Cannot identify $role process path" }
    $records = @((Read-State) | Where-Object { Match-Process $_ })
    $records += [pscustomobject]@{ Id=$process.Id; Path=$process.Path; Start=$process.StartTime.ToUniversalTime().Ticks.ToString(); Role=$role }
    ConvertTo-Json -InputObject @($records) | Set-Content -LiteralPath $stateFile
}
function Assert-PortFree([int]$Port) {
    $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { $probe.Start() } catch { throw "Port $Port unavailable; no existing service will be reused or stopped." }
    finally { $probe.Stop() }
}
function Start-LabProcess($File, $Arguments, $Role) {
    foreach ($record in @(Read-State)) { if ($record.Role -eq $Role -and (Match-Process $record)) { throw "$Role already running" } }
    $options = @{ FilePath=$File; WorkingDirectory=$workspace; WindowStyle='Hidden'; PassThru=$true; RedirectStandardOutput=(Join-Path $labRoot "$Role.out.log"); RedirectStandardError=(Join-Path $labRoot "$Role.err.log") }
    if ($Role -like 'client-*') { $options.WindowStyle='Normal' }
    if ($Arguments.Count -gt 0) { $options.ArgumentList=$Arguments }
    $process = Start-Process @options
    Save-Process $process $Role
    return $process
}
function Native($File, $Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed ($LASTEXITCODE)" }
}

if ($Action -eq 'Prepare') {
    Assert-LabTree
    foreach ($record in @(Read-State)) { if (Match-Process $record) { throw 'Stop the lab before preparing it again' } }
    New-Item -ItemType Directory -Force -Path $labRoot | Out-Null
    # Lab secrets and tokens in logs must remain private to this Windows account.
    $accountSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Native 'icacls.exe' @($labRoot, '/inheritance:r', '/grant:r', "*${accountSid}:(OI)(CI)F")
    if (-not (Test-Path (Join-Path $pgBin 'initdb.exe'))) { throw 'Portable PostgreSQL binaries missing in .postgres/pgsql/bin; existing data will never be reused.' }
    $passwordFile = Join-Path $labRoot 'pg-password'
    if (-not (Test-Path -LiteralPath $passwordFile)) {
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        ([BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()) | Set-Content -LiteralPath $passwordFile -Encoding ascii
    }
    $pgData = Join-Path $labRoot 'postgres'
    if (-not (Test-Path -LiteralPath $pgData)) {
        Native (Join-Path $pgBin 'initdb.exe') @('-D', $pgData, '-U', 'nexus_lab', '--pwfile', $passwordFile, '--auth=scram-sha-256', '--encoding=UTF8', '--no-locale')
        Add-Content -LiteralPath (Join-Path $pgData 'postgresql.conf') -Value "`nlisten_addresses = '127.0.0.1'`nport = 15432"
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $labRoot 'frontend-env') | Out-Null
    Push-Location $workspace
    $oldTarget = $env:CARGO_TARGET_DIR
    $oldConfig = $env:TAURI_CONFIG
    $oldDatabase = $env:DATABASE_URL
    $oldOffline = $env:SQLX_OFFLINE
    $oldPgPassword = $env:PGPASSWORD
    $preparePg = $false
    try {
        $env:CARGO_TARGET_DIR = Join-Path $labRoot 'target'
        $env:TAURI_CONFIG = '{"identifier":"com.nexus.testlab","productName":"NEXUS Test Lab","build":{"devUrl":"http://127.0.0.1:1420"},"bundle":{"active":false},"plugins":{"updater":{"endpoints":[]}}}'
        Native 'cargo' @('build','--manifest-path','src-tauri/Cargo.toml','--features','test-lab')
        # SQLx query! macros need a schema during compilation. Never resolve it from project .env.
        Assert-PortFree 15432
        Native (Join-Path $pgBin 'pg_ctl.exe') @('-D', $pgData, '-l', (Join-Path $labRoot 'postgres.log'), '-w', 'start')
        $preparePg = $true
        $pgId = [int](Get-Content (Join-Path $pgData 'postmaster.pid') -TotalCount 1)
        Save-Process (Get-Process -Id $pgId) 'postgres'
        $env:PGPASSWORD = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
        foreach ($database in @('nexus_lab','nexus_lab_compile')) {
            $exists = & (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p 15432 -U nexus_lab -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$database'"
            if ($LASTEXITCODE -ne 0) { throw 'Lab database check failed' }
            if ($exists -ne '1') { Native (Join-Path $pgBin 'createdb.exe') @('-h','127.0.0.1','-p','15432','-U','nexus_lab',$database) }
        }
        foreach ($migration in @(Get-ChildItem -LiteralPath (Join-Path $workspace 'nexus-server/migrations') -Filter '*.sql' | Sort-Object Name)) {
            Native (Join-Path $pgBin 'psql.exe') @('-h','127.0.0.1','-p','15432','-U','nexus_lab','-d','nexus_lab_compile','-v','ON_ERROR_STOP=1','-f',$migration.FullName)
        }
        $env:DATABASE_URL = "postgres://nexus_lab:$($env:PGPASSWORD)@127.0.0.1:15432/nexus_lab_compile"
        $env:SQLX_OFFLINE = 'false'
        # SQLx 0.8 unconditionally reads manifest/.env. Build an exact disposable
        # source stage containing an empty .env, never the project's secrets.
        $serverBuild = Join-Path $labRoot 'server-build'
        if (Test-Path -LiteralPath $serverBuild) {
            if ([IO.Path]::GetFullPath($serverBuild) -ne (Join-Path $workspace '.nexus-lab\server-build')) { throw 'Invalid build stage path' }
            Remove-Item -LiteralPath $serverBuild -Recurse -Force
        }
        New-Item -ItemType Directory -Path $serverBuild | Out-Null
        foreach ($entry in @('Cargo.toml','Cargo.lock','src','migrations')) {
            Copy-Item -LiteralPath (Join-Path $workspace "nexus-server/$entry") -Destination $serverBuild -Recurse
        }
        Set-Content -LiteralPath (Join-Path $serverBuild '.env') -Value '# Deliberately empty: lab compilation only'
        Native 'cargo' @('build','--manifest-path',(Join-Path $serverBuild 'Cargo.toml'),'--features','test-lab','--locked')
    } finally {
        $env:CARGO_TARGET_DIR=$oldTarget; $env:TAURI_CONFIG=$oldConfig
        $env:DATABASE_URL=$oldDatabase; $env:SQLX_OFFLINE=$oldOffline; $env:PGPASSWORD=$oldPgPassword
        if ($preparePg) { Native (Join-Path $pgBin 'pg_ctl.exe') @('-D', $pgData, '-m', 'fast', '-w', 'stop') }
        Pop-Location
    }
    Write-Host 'Prepared Debug lab. Run Backend, then A and B.'
    exit
}
if ($Action -eq 'Status') {
    foreach ($record in @(Read-State)) {
        Write-Host "$($record.Role): PID $($record.Id), running=$([bool](Match-Process $record))"
    }
    exit
}
if ($Action -in @('Stop','Clean')) {
    Assert-LabTree
    $records = @(Read-State)
    foreach ($record in $records) {
        if ($record.Role -eq 'postgres') { continue }
        $process = Match-Process $record
        if ($process) { Stop-Process -InputObject $process; $process.WaitForExit(10000) | Out-Null }
    }
    foreach ($record in $records) {
        if ($record.Role -eq 'postgres' -and (Match-Process $record)) {
            Native (Join-Path $pgBin 'pg_ctl.exe') @('-D', (Join-Path $labRoot 'postgres'), '-m', 'fast', '-w', 'stop')
        }
    }
    if ($Action -eq 'Clean') {
        if (Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($labRoot + '\', [StringComparison]::OrdinalIgnoreCase) }) { throw 'Lab process still alive; refusing cleanup' }
        if (Test-Path (Join-Path $labRoot 'postgres\postmaster.pid')) { throw 'PostgreSQL lock present; refusing cleanup' }
        $webviews = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object {
            $_.CommandLine -and $_.CommandLine.Contains($labRoot + '\')
        })
        if ($webviews.Count -gt 0) { throw 'Lab WebView children still running; cleanup refused without affecting other WebViews' }
        # Only dedicated keyring entries, through the dedicated Debug executable.
        $exe = Join-Path $labRoot 'target\debug\nexus.exe'
        if (-not (Test-Path -LiteralPath $exe)) { throw 'Debug lab executable required to remove lab keyring entries; run Prepare first' }
        if (Test-Path -LiteralPath $exe) {
            $oldProfile = $env:NEXUS_LAB_PROFILE
            try { foreach ($profile in @('A','B')) { $env:NEXUS_LAB_PROFILE=$profile; $clearProcess = Start-Process -FilePath $exe -ArgumentList '--lab-clear-credentials' -WindowStyle Hidden -Wait -PassThru; if ($clearProcess.ExitCode -ne 0) { throw 'Cannot clear lab credentials' } } }
            finally { $env:NEXUS_LAB_PROFILE=$oldProfile }
        }
        if ([IO.Path]::GetFullPath($labRoot) -ne (Join-Path $workspace '.nexus-lab')) { throw 'Invalid cleanup path' }
        Remove-Item -LiteralPath $labRoot -Recurse -Force
    } elseif (Test-Path -LiteralPath $stateFile) { Remove-Item -LiteralPath $stateFile }
    exit
}
Assert-LabTree
if (-not (Test-Path (Join-Path $labRoot 'target\debug\nexus.exe'))) { throw 'Run Prepare first' }
if ($Action -eq 'Backend') {
    Assert-PortFree 13001
    Assert-PortFree 15432
    Assert-PortFree 1420
    Native (Join-Path $pgBin 'pg_ctl.exe') @('-D', (Join-Path $labRoot 'postgres'), '-l', (Join-Path $labRoot 'postgres.log'), '-w', 'start')
    $pgId = [int](Get-Content (Join-Path $labRoot 'postgres\postmaster.pid') -TotalCount 1)
    Save-Process (Get-Process -Id $pgId) 'postgres'
    $oldPassword = $env:PGPASSWORD
    try {
        $env:PGPASSWORD = (Get-Content (Join-Path $labRoot 'pg-password') -Raw).Trim()
        $exists = & (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p 15432 -U nexus_lab -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='nexus_lab'"
        if ($LASTEXITCODE -ne 0) { throw 'Lab database check failed' }
        if ($exists -ne '1') { Native (Join-Path $pgBin 'createdb.exe') @('-h','127.0.0.1','-p','15432','-U','nexus_lab','nexus_lab') }
    } finally { $env:PGPASSWORD=$oldPassword }
    Start-LabProcess (Join-Path $labRoot 'target\debug\nexus-server.exe') @() 'backend' | Out-Null
    Start-LabProcess (Get-Command node.exe).Source @('node_modules/vite/bin/vite.js','--config','vite.lab.config.ts') 'vite' | Out-Null
    Write-Host 'Backend 127.0.0.1:13001; PostgreSQL 127.0.0.1:15432; Vite 127.0.0.1:1420.'
} else {
    $roles = @((Read-State) | Where-Object { Match-Process $_ } | ForEach-Object { $_.Role })
    if ('backend' -notin $roles -or 'vite' -notin $roles) { throw 'Start Backend first' }
    $oldProfile = $env:NEXUS_LAB_PROFILE
    try {
        $env:NEXUS_LAB_PROFILE = $Action
        Start-LabProcess (Join-Path $labRoot 'target\debug\nexus.exe') @() "client-$Action" | Out-Null
    } finally { $env:NEXUS_LAB_PROFILE=$oldProfile }
    Write-Host "Client $Action launched; verify its window and profile before testing."
}
