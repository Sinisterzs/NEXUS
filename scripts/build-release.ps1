# NEXUS - Build de Release do Executável Desktop
$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   NEXUS - Build Release Desktop" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1. Verifica configuração permanente
$configPath = Join-Path $PSScriptRoot "..\nexus.config.json"
if (-not (Test-Path $configPath)) {
    Write-Host "[ERRO] nexus.config.json não encontrado na raiz do projeto." -ForegroundColor Red
    exit 1
}

$rootPath = Join-Path $PSScriptRoot ".."
Set-Location $rootPath

# Fecha instâncias em execução do nexus para liberar o arquivo para compilação
$runningApp = Get-Process -Name "nexus" -ErrorAction SilentlyContinue
if ($runningApp) {
    Write-Host "[INFO] Fechando instância do NEXUS em execução para atualizar o binário..." -ForegroundColor Yellow
    $runningApp | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

# 2. Build do Frontend
Write-Host "[1/2] Compilando frontend React + Vite..." -ForegroundColor Cyan
& npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERRO] Falha na compilação do frontend." -ForegroundColor Red
    exit 1
}

# 3. Build do Tauri Desktop
Write-Host "[2/2] Compilando executável nativo Release (Tauri 2)..." -ForegroundColor Cyan
Get-Process -Name "nexus" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
& npm run tauri build -- --no-bundle
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERRO] Falha no build nativo do Tauri." -ForegroundColor Red
    exit 1
}

$exePath = Join-Path $rootPath "src-tauri\target\release\nexus.exe"
if (Test-Path $exePath) {
    $item = Get-Item $exePath
    $sizeMb = [math]::Round($item.Length / 1MB, 2)
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Build Release concluído com sucesso!  " -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "Arquivo: $exePath" -ForegroundColor White
    Write-Host "Tamanho: $sizeMb MB" -ForegroundColor White
    Write-Host "O executável contém a configuração OAuth embutida e não requer variáveis manuais." -ForegroundColor DarkGray
} else {
    Write-Host "[ERRO] Executável não encontrado em $exePath" -ForegroundColor Red
    exit 1
}
