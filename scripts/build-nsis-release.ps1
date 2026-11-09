# NEXUS - Build do Instalador NSIS Assinado para Release
$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
Set-Location $rootDir

$keyPath = Join-Path $rootDir ".tauri\nexus.key"
if (-not (Test-Path $keyPath)) {
    Write-Host "[ERRO] Chave privada .tauri\nexus.key não encontrada." -ForegroundColor Red
    exit 1
}

$privateKey = Get-Content -Raw $keyPath
$env:TAURI_SIGNING_PRIVATE_KEY = $privateKey

Write-Host "[INFO] Iniciando compilação do pacote NSIS com assinatura Minisign..." -ForegroundColor Cyan

# Fecha instância do app se estiver aberta
Get-Process -Name "nexus" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

& npx tauri build --bundles nsis
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERRO] Falha no build do instalador NSIS." -ForegroundColor Red
    exit 1
}

Write-Host "[OK] Build do instalador NSIS concluído com sucesso." -ForegroundColor Green
