param([ValidateSet('Prepare','Check','Test','Preview','Stop')][string]$Action='Test')
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=Join-Path $workspace 'scratch\diagnostics-validation'
$pg=Join-Path $workspace '.postgres\pgsql\bin'
$data=Join-Path $root 'postgres'
$stage=Join-Path $root 'nexus-server'
New-Item -ItemType Directory -Path $root -Force | Out-Null
if($Action -eq 'Stop'){
    if(Test-Path -LiteralPath (Join-Path $data 'postmaster.pid')){& (Join-Path $pg 'pg_ctl.exe') -D $data -m fast -w stop}
    exit
}
if(-not (Test-Path -LiteralPath (Join-Path $data 'PG_VERSION'))){
    $probe=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,15439)
    try{$probe.Start()}finally{$probe.Stop()}
    $bytes=New-Object byte[] 32;[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    [Convert]::ToHexString($bytes).ToLowerInvariant() | Set-Content -LiteralPath (Join-Path $root 'pg-password') -Encoding ascii
    & (Join-Path $pg 'initdb.exe') -D $data -U nexus_diag --pwfile (Join-Path $root 'pg-password') --auth=scram-sha-256 --encoding=UTF8 --no-locale > (Join-Path $root 'initdb.txt')
    if($LASTEXITCODE -ne 0){throw 'Isolated initdb failed'}
    Add-Content -LiteralPath (Join-Path $data 'postgresql.conf') -Value "`nlisten_addresses = '127.0.0.1'`nport = 15439"
}
$oldPassword=$env:PGPASSWORD;$oldDatabase=$env:DATABASE_URL;$oldOffline=$env:SQLX_OFFLINE;$oldTarget=$env:CARGO_TARGET_DIR
try{
    $env:PGPASSWORD=(Get-Content -LiteralPath (Join-Path $root 'pg-password') -Raw).Trim()
    if(-not(Test-Path -LiteralPath (Join-Path $data 'postmaster.pid'))){
        $probe=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,15439)
        try{$probe.Start()}finally{$probe.Stop()}
        $process=Start-Process -FilePath (Join-Path $pg 'pg_ctl.exe') -ArgumentList @('-D',('"'+$data+'"'),'-l',('"'+(Join-Path $root 'postgres.log')+'"'),'-w','start') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root 'pg-start.out') -RedirectStandardError (Join-Path $root 'pg-start.err')
        if(-not $process.WaitForExit(15000)){throw 'Isolated pg_ctl did not finish'}
        $process.Refresh()
        if($process.ExitCode -ne 0){throw 'Isolated PostgreSQL start failed'}
    }
    $exists=& (Join-Path $pg 'psql.exe') -h 127.0.0.1 -p 15439 -U nexus_diag -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='nexus_diagnostics'"
    if($LASTEXITCODE -ne 0){throw 'Isolated PostgreSQL identity failed'}
    if($exists -ne '1'){
        & (Join-Path $pg 'createdb.exe') -h 127.0.0.1 -p 15439 -U nexus_diag nexus_diagnostics
        foreach($migration in Get-ChildItem -LiteralPath (Join-Path $workspace 'nexus-server\migrations') -Filter '*.sql' | Sort-Object Name){
            & (Join-Path $pg 'psql.exe') -h 127.0.0.1 -p 15439 -U nexus_diag -d nexus_diagnostics -v ON_ERROR_STOP=1 -f $migration.FullName > (Join-Path $root 'migration-last.txt')
            if($LASTEXITCODE -ne 0){throw 'Isolated migration failed'}
        }
    }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    foreach($entry in @('Cargo.toml','Cargo.lock','src','migrations','admin','examples')){
        Copy-Item -LiteralPath (Join-Path $workspace "nexus-server\$entry") -Destination $stage -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $workspace 'shared') -Destination $root -Recurse -Force
    Set-Content -LiteralPath (Join-Path $stage '.env') -Value '# Empty isolated build environment'
    $env:DATABASE_URL="postgres://nexus_diag:$($env:PGPASSWORD)@127.0.0.1:15439/nexus_diagnostics"
    $env:SQLX_OFFLINE='false';$env:CARGO_TARGET_DIR=Join-Path $workspace 'nexus-server\target'
    if($Action -eq 'Check'){
        & cargo check --manifest-path (Join-Path $stage 'Cargo.toml') --offline --locked
    }elseif($Action -eq 'Preview'){
        $env:NEXUS_DIAGNOSTICS_TEST_ROOT=$root
        & cargo run --manifest-path (Join-Path $stage 'Cargo.toml') --offline --locked --example diagnostics_preview
    }elseif($Action -eq 'Test'){
        $env:NEXUS_DIAGNOSTICS_TEST_ROOT=$root
        & cargo test --manifest-path (Join-Path $stage 'Cargo.toml') --offline --locked --lib diagnostics -- --test-threads=1
    }
    if($LASTEXITCODE -ne 0){throw 'Diagnostics backend validation failed'}
}finally{
    $env:PGPASSWORD=$oldPassword;$env:DATABASE_URL=$oldDatabase;$env:SQLX_OFFLINE=$oldOffline;$env:CARGO_TARGET_DIR=$oldTarget
    Remove-Item Env:NEXUS_DIAGNOSTICS_TEST_ROOT -ErrorAction SilentlyContinue
}
