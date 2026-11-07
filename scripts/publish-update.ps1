# NEXUS - Gerador de Atualizações Assinadas para o GitHub Releases
$ErrorActionPreference = "Stop"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "   NEXUS - Gerar Atualização Automática (GitHub)   " -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

$rootDir = Split-Path -Parent $PSScriptRoot
Set-Location $rootDir

# 1. Verifica chave privada de assinatura
$keyPath = Join-Path $rootDir ".tauri\nexus.key"
if (-not (Test-Path $keyPath)) {
    Write-Host "[ERRO] Chave privada .tauri\nexus.key não encontrada." -ForegroundColor Red
    exit 1
}

$privateKey = Get-Content -Raw $keyPath
$env:TAURI_SIGNING_PRIVATE_KEY = $privateKey

# 2. Obtém versão atual configurada em tauri.conf.json
$tauriConfPath = Join-Path $rootDir "src-tauri\tauri.conf.json"
$tauriConf = Get-Content -Raw $tauriConfPath | ConvertFrom-Json
$version = $tauriConf.version

Write-Host "[INFO] Versão do Release: v$version" -ForegroundColor Yellow
Write-Host "[INFO] Repositório alvo: https://github.com/Sinisterzs/NEXUS" -ForegroundColor Yellow

# 3. Compila o frontend React + Vite
Write-Host "[1/3] Compilando frontend..." -ForegroundColor Cyan
& npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERRO] Falha no build do frontend." -ForegroundColor Red
    exit 1
}

# 4. Compila o pacote nativo e assina digitalmente os artefatos de update
Write-Host "[2/3] Compilando e assinando artefatos de update com Tauri 2..." -ForegroundColor Cyan
$runningApp = Get-Process -Name "nexus" -ErrorAction SilentlyContinue
if ($runningApp) {
    Write-Host "[INFO] Fechando instância do NEXUS para compilação..." -ForegroundColor Yellow
    $runningApp | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

& npm run tauri build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERRO] Falha no build e assinatura do Tauri." -ForegroundColor Red
    exit 1
}

# 5. Coleta e organiza os arquivos gerados em dist-release/v<versao>
Write-Host "[3/3] Organizando arquivos para publicação no GitHub Releases..." -ForegroundColor Cyan
$distDir = Join-Path $rootDir "dist-release\v$version"
if (-not (Test-Path $distDir)) {
    New-Item -ItemType Directory -Path $distDir -Force | Out-Null
}

$bundleDir = Join-Path $rootDir "src-tauri\target\release\bundle\nsis"
$releaseExe = Join-Path $rootDir "src-tauri\target\release\nexus.exe"

# Copia instalador e arquivos de update
if (Test-Path $bundleDir) {
    Get-ChildItem -Path $bundleDir -Filter "*$version*" | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $distDir -Force
    }
}

# Copia executável direto se disponível
if (Test-Path $releaseExe) {
    Copy-Item -Path $releaseExe -Destination (Join-Path $distDir "nexus.exe") -Force
}

# Localiza latest.json gerado pelo Tauri
$latestJsonSrc = Join-Path $rootDir "src-tauri\target\release\latest.json"
if (-not (Test-Path $latestJsonSrc)) {
    # Procura recursivamente
    $found = Get-ChildItem -Path "src-tauri\target\release" -Filter "latest.json" -Recurse | Select-Object -First 1
    if ($found) {
        $latestJsonSrc = $found.FullName
    }
}

if (Test-Path $latestJsonSrc) {
    Copy-Item -Path $latestJsonSrc -Destination (Join-Path $distDir "latest.json") -Force
}

Write-Host "==================================================" -ForegroundColor Green
Write-Host "  Atualização v$version gerada e assinada com sucesso! " -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host "Arquivos prontos para o GitHub em:" -ForegroundColor White
Write-Host "  $distDir" -ForegroundColor Cyan
Write-Host ""
Write-Host "COMO PUBLICAR NO GITHUB (Passo a Passo):" -ForegroundColor Yellow
Write-Host "1. Acesse: https://github.com/Sinisterzs/NEXUS/releases/new" -ForegroundColor White
Write-Host "2. No campo 'Tag version', digite: v$version (e selecione 'Create new tag: v$version')" -ForegroundColor White
Write-Host "3. No título, coloque: NEXUS v$version" -ForegroundColor White
Write-Host "4. Arraste TODOS os arquivos da pasta '$distDir' para a área de anexos do GitHub:" -ForegroundColor White
Write-Host "   - latest.json (Obrigatório: informa aos apps que há update)" -ForegroundColor Gray
Write-Host "   - *.nsis.zip (Obrigatório: arquivo que o app baixa automaticamente)" -ForegroundColor Gray
Write-Host "   - *.nsis.zip.sig (Obrigatório: assinatura criptográfica de segurança)" -ForegroundColor Gray
Write-Host "   - *.exe (Opcional: instalador para novos usuários baixarem)" -ForegroundColor Gray
Write-Host "5. Clique em 'Publish release'." -ForegroundColor White
Write-Host ""
Write-Host "Assim que você publicar, o NEXUS de todos os seus amigos vai detectar e atualizar sozinho!" -ForegroundColor Green
