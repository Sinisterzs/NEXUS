# NEXUS - Inicialização Completa do Ambiente de Desenvolvimento
$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   NEXUS - Iniciando Ambiente Dev" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1. Executa verificação rápida de dependências
& "$PSScriptRoot\check-deps.ps1"

# 2. Verifica se o backend já está respondendo na porta 3001
$backendRunning = $false
try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:3001/health" -Method Get -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($resp.status -eq "ok") {
        $backendRunning = $true
        Write-Host "[OK] Backend NEXUS já está em execução (porta 3001)." -ForegroundColor Green
    }
} catch {
    $backendRunning = $false
}

if (-not $backendRunning) {
    # Garante que PostgreSQL esteja rodando na porta 5432
    $pgConn = Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue
    if (-not $pgConn) {
        Write-Host "[INFO] Iniciando banco de dados PostgreSQL..." -ForegroundColor Yellow
        $localPgCtl = Join-Path $PSScriptRoot "..\.postgres\pgsql\bin\pg_ctl.exe"
        $localPgData = Join-Path $PSScriptRoot "..\.postgres\data"
        $localPgLog = Join-Path $PSScriptRoot "..\.postgres\pg.log"
        if ((Test-Path $localPgCtl) -and (Test-Path $localPgData)) {
            $pidFile = Join-Path $localPgData "postmaster.pid"
            if (Test-Path $pidFile) {
                $stalePid = (Get-Content $pidFile)[0].Trim()
                $proc = Get-Process -Id $stalePid -ErrorAction SilentlyContinue
                if (-not $proc) {
                    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
                }
            }
            Start-Process -FilePath $localPgCtl -ArgumentList "-D `"$localPgData`" -l `"$localPgLog`" start" -NoNewWindow
            Start-Sleep -Seconds 2
        }
    }

    Write-Host "[INFO] Iniciando backend nexus-server..." -ForegroundColor Yellow
    $serverManifest = Join-Path $PSScriptRoot "..\nexus-server\Cargo.toml"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "cargo run --manifest-path '$serverManifest'"
    
    # Aguarda backend subir
    Write-Host "[INFO] Aguardando inicialização do servidor..." -ForegroundColor DarkGray
    $retries = 10
    while ($retries -gt 0 -and -not $backendRunning) {
        Start-Sleep -Seconds 1
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:3001/health" -Method Get -TimeoutSec 1 -ErrorAction SilentlyContinue
            if ($resp.status -eq "ok") {
                $backendRunning = $true
            }
        } catch {
            $retries--
        }
    }

    if ($backendRunning) {
        Write-Host "[OK] Backend NEXUS online com sucesso!" -ForegroundColor Green
    } else {
        Write-Host "[AVISO] Backend demorou para inicializar. O aplicativo abrirá em modo local." -ForegroundColor Yellow
    }
}

# 3. Inicia o Tauri em modo de desenvolvimento
Write-Host "[INFO] Iniciando NEXUS Desktop (tauri dev)..." -ForegroundColor Cyan
$rootPath = Join-Path $PSScriptRoot ".."
Set-Location $rootPath
& npm run tauri dev
