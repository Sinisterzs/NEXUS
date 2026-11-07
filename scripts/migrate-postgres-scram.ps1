# NEXUS - Procedimento de Migração de Autenticação PostgreSQL (trust -> scram-sha-256)
# Cria usuário de aplicação de privilégios mínimos 'nexus_app' e restringe acesso do superuser 'postgres'
[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$AppPassword,

    [Parameter(Mandatory=$false)]
    [string]$AdminPassword,

    [Parameter(Mandatory=$false)]
    [int]$Port = 5432,

    [Parameter(Mandatory=$false)]
    [switch]$Rollback
)

$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $rootDir "nexus-server"
$pgBin = Join-Path $rootDir ".postgres\pgsql\bin"
$pgData = Join-Path $rootDir ".postgres\data"
$psql = Join-Path $pgBin "psql.exe"
$pg_ctl = Join-Path $pgBin "pg_ctl.exe"
$hbaFile = Join-Path $pgData "pg_hba.conf"
$hbaBackup = Join-Path $pgData "pg_hba.conf.bak"
$envFile = Join-Path $serverDir ".env"
$envBackup = Join-Path $serverDir ".env.bak"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   NEXUS - Migração de Autenticação PostgreSQL SCRAM-SHA-256   " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# Verificações de pré-requisitos
if (-not (Test-Path $psql) -or -not (Test-Path $pg_ctl)) {
    throw "Executáveis do PostgreSQL (.postgres/pgsql/bin) não encontrados em $pgBin"
}

if ($Rollback) {
    Write-Host "[ROLLBACK] Restaurando configuração anterior (trust)..." -ForegroundColor Yellow
    if (Test-Path $hbaBackup) {
        Copy-Item $hbaBackup $hbaFile -Force
        & $pg_ctl -D $pgData reload
        Write-Host "[ROLLBACK] pg_hba.conf restaurado a partir de backup." -ForegroundColor Green
    }
    if (Test-Path $envBackup) {
        Copy-Item $envBackup $envFile -Force
        Write-Host "[ROLLBACK] .env do nexus-server restaurado a partir de backup." -ForegroundColor Green
    }
    Write-Host "[ROLLBACK] Concluído." -ForegroundColor Green
    exit 0
}

# Gera senhas seguras se não fornecidas
if ([string]::IsNullOrWhiteSpace($AppPassword)) {
    $bytes = New-Object byte[] 24
    (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bytes)
    $AppPassword = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

if ([string]::IsNullOrWhiteSpace($AdminPassword)) {
    $bytes = New-Object byte[] 24
    (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bytes)
    $AdminPassword = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

Write-Host "[1/6] Fazendo backup de segurança de pg_hba.conf e .env..." -ForegroundColor Yellow
if (-not (Test-Path $hbaBackup) -and (Test-Path $hbaFile)) {
    Copy-Item $hbaFile $hbaBackup -Force
}
if (-not (Test-Path $envBackup) -and (Test-Path $envFile)) {
    Copy-Item $envFile $envBackup -Force
}

Write-Host "[2/6] Configurando senhas SCRAM-SHA-256 e provisionando usuário nexus_app..." -ForegroundColor Yellow
$setupSql = @"
ALTER USER postgres WITH PASSWORD '$AdminPassword';

DO `$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'nexus_app') THEN
        CREATE USER nexus_app WITH PASSWORD '$AppPassword' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    ELSE
        ALTER USER nexus_app WITH PASSWORD '$AppPassword' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF;
END
`$\$;

GRANT CONNECT ON DATABASE nexus_db TO nexus_app;
"@
& $psql -h 127.0.0.1 -p $Port -U postgres -w -c $setupSql

Write-Host "[3/6] Concedendo privilégios mínimos no banco nexus_db..." -ForegroundColor Yellow
$grantSql = @"
GRANT USAGE, CREATE ON SCHEMA public TO nexus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nexus_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO nexus_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nexus_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO nexus_app;
"@
& $psql -h 127.0.0.1 -p $Port -U postgres -d nexus_db -w -c $grantSql

Write-Host "[4/6] Atualizando pg_hba.conf para impor scram-sha-256..." -ForegroundColor Yellow
$hbaHeader = @"
# ====================================================================
# NEXUS Hardened PostgreSQL Configuration (SCRAM-SHA-256)
# Gerado pelo procedimento de hardening da Fase 2.4.5B4.1
# ====================================================================
local   all             all                                     trust
host    nexus_db        nexus_app       127.0.0.1/32            scram-sha-256
host    nexus_db        nexus_app       ::1/128                 scram-sha-256
host    all             postgres        127.0.0.1/32            scram-sha-256
host    all             postgres        ::1/128                 scram-sha-256
"@
Set-Content -Path $hbaFile -Value $hbaHeader

Write-Host "[5/6] Recarregando configurações do PostgreSQL via pg_ctl..." -ForegroundColor Yellow
& $pg_ctl -D $pgData reload
Start-Sleep -Seconds 1

Write-Host "[6/6] Validando conexão autenticada como nexus_app..." -ForegroundColor Yellow
$env:PGPASSWORD = $AppPassword
$verifyRes = & $psql -h 127.0.0.1 -p $Port -U nexus_app -d nexus_db -w -t -c "SELECT current_user;"
$currentUser = "$verifyRes".Trim()

if ($currentUser -eq "nexus_app") {
    Write-Host "[SUCESSO] Usuário nexus_app autenticado com sucesso via SCRAM-SHA-256!" -ForegroundColor Green

    # Atualiza nexus-server/.env
    if (Test-Path $envFile) {
        $envLines = Get-Content $envFile
        $newLines = @()
        $updated = $false
        foreach ($line in $envLines) {
            if ($line -match "^DATABASE_URL=") {
                $newLines += "DATABASE_URL=postgres://nexus_app:$AppPassword@127.0.0.1:$Port/nexus_db"
                $updated = $true
            } else {
                $newLines += $line
            }
        }
        if (-not $updated) {
            $newLines += "DATABASE_URL=postgres://nexus_app:$AppPassword@127.0.0.1:$Port/nexus_db"
        }
        Set-Content -Path $envFile -Value $newLines
        Write-Host "[SUCESSO] DATABASE_URL atualizado com credenciais seguras em $envFile" -ForegroundColor Green
    }

    Write-Host "`nCredenciais configuradas:" -ForegroundColor Cyan
    Write-Host "  Usuário aplicação : nexus_app"
    Write-Host "  Senha aplicação   : $AppPassword"
    Write-Host "  Usuário admin     : postgres"
    Write-Host "  Senha admin       : $AdminPassword"
    Write-Host "Guarde estas credenciais em local seguro.`n" -ForegroundColor DarkYellow
} else {
    Write-Host "[ERRO] Falha ao verificar autenticação de nexus_app. Execute com -Rollback para restaurar." -ForegroundColor Red
    exit 1
}
