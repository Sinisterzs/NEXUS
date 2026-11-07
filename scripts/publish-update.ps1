# NEXUS - Gerador e Publicador Automático de Atualizações para o GitHub Releases
$ErrorActionPreference = "Stop"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "   NEXUS - Publicação Automática de Release (v2)  " -ForegroundColor Cyan
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
$tag = "v$version"
$owner = "Sinisterzs"
$repo = "NEXUS"

Write-Host "[INFO] Versão do Release: $tag" -ForegroundColor Yellow
Write-Host "[INFO] Repositório alvo: https://github.com/$owner/$repo" -ForegroundColor Yellow

# 3. Compila o frontend React + Vite
Write-Host "[1/5] Compilando frontend..." -ForegroundColor Cyan
& npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERRO] Falha no build do frontend." -ForegroundColor Red
    exit 1
}

# 4. Compila o pacote nativo com Tauri 2
Write-Host "[2/5] Compilando binário nativo do NEXUS..." -ForegroundColor Cyan
$runningApp = Get-Process -Name "nexus" -ErrorAction SilentlyContinue
if ($runningApp) {
    Write-Host "[INFO] Fechando instância do NEXUS para compilação..." -ForegroundColor Yellow
    $runningApp | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

& npm run tauri build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERRO] Falha no build do Tauri." -ForegroundColor Red
    exit 1
}

# 5. Coleta instalador NSIS e assinatura gerados pelo Tauri para o auto-update
Write-Host "[3/5] Coletando instalador e assinatura NSIS para o auto-update..." -ForegroundColor Cyan
$releaseExe = Join-Path $rootDir "src-tauri\target\release\nexus.exe"
$nsisDir = Join-Path $rootDir "src-tauri\target\release\bundle\nsis"
$setupExe = Get-ChildItem -Path $nsisDir -Filter "*$version*-setup.exe" | Select-Object -First 1
$setupSig = Get-ChildItem -Path $nsisDir -Filter "*$version*-setup.exe.sig" | Select-Object -First 1

if (-not $setupExe -or -not $setupSig) {
    Write-Host "[ERRO] Instalador NSIS ou assinatura não encontrados em $nsisDir" -ForegroundColor Red
    exit 1
}

$signature = (Get-Content -Raw $setupSig.FullName).Trim()

# Gera latest.json do updater (UTF-8 sem BOM)
$latestObj = @{
    "version" = $version
    "notes" = "NEXUS $tag - Atualização Automática"
    "pub_date" = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    "platforms" = @{
        "windows-x86_64" = @{
            "signature" = $signature
            "url" = "https://github.com/$owner/$repo/releases/download/$tag/$($setupExe.Name)"
        }
    }
}
$latestJsonContent = $latestObj | ConvertTo-Json -Depth 5

$latestJsonPath = Join-Path $rootDir "latest.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($latestJsonPath, $latestJsonContent, $utf8NoBom)

# 6. Conecta à API do GitHub usando credenciais locais
Write-Host "[4/5] Conectando ao GitHub para criar/atualizar Release..." -ForegroundColor Cyan
$token = $env:GITHUB_TOKEN
if (-not $token) {
    $gitCredInput = "protocol=https`nhost=github.com`n`n"
    $gitCredOutput = $gitCredInput | git credential fill
    $tokenLine = $gitCredOutput | Select-String "password=(.*)"
    if ($tokenLine) {
        $token = $tokenLine.Matches.Groups[1].Value.Trim()
    }
}

if (-not $token) {
    Write-Host "[ERRO] Não foi possível autenticar no GitHub. Defina GITHUB_TOKEN ou configure git credentials." -ForegroundColor Red
    exit 1
}

$headers = @{
    "Authorization" = "Bearer $token"
    "Accept"        = "application/vnd.github.v3+json"
    "User-Agent"    = "NEXUS-Release-Bot"
}

# Lê patch notes se existir, senão gera padrão
$notesPath = Join-Path $PSScriptRoot "release-notes-$tag.md"
if (Test-Path $notesPath) {
    $releaseBody = [System.IO.File]::ReadAllText($notesPath, [System.Text.Encoding]::UTF8)
} else {
    $releaseBody = "## NEXUS $tag`n`nAtualização automática de correções e melhorias.`n`n### Mudanças:`n- Correções de estabilidade e melhorias de conectividade WebRTC.`n- Atualização aplicada de forma automática pelo NEXUS."
}

$releaseName = "NEXUS $tag"
$release = $null

try {
    $existingUri = "https://api.github.com/repos/$owner/$repo/releases/tags/$tag"
    $release = Invoke-RestMethod -Uri $existingUri -Headers $headers -Method Get
    Write-Host "[INFO] Release $tag já existe. Atualizando metadados..." -ForegroundColor Yellow
    $patchPayload = @{
        "name" = $releaseName
        "body" = [string]$releaseBody
        "draft" = $false
        "prerelease" = $false
    }
    $patchJson = [System.Text.Encoding]::UTF8.GetBytes(($patchPayload | ConvertTo-Json))
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/$($release.id)" -Headers $headers -Method Patch -Body $patchJson -ContentType "application/json; charset=utf-8"
} catch {
    Write-Host "[INFO] Criando novo Release $tag no GitHub..." -ForegroundColor Cyan
    $createPayload = @{
        "tag_name"         = $tag
        "target_commitish" = "main"
        "name"             = $releaseName
        "body"             = [string]$releaseBody
        "draft"            = $false
        "prerelease"       = $false
    }
    $createJson = [System.Text.Encoding]::UTF8.GetBytes(($createPayload | ConvertTo-Json))
    $createUri = "https://api.github.com/repos/$owner/$repo/releases"
    $release = Invoke-RestMethod -Uri $createUri -Headers $headers -Method Post -Body $createJson -ContentType "application/json; charset=utf-8"
}

$releaseId = $release.id

# 7. Upload de artefatos
Write-Host "[5/5] Enviando arquivos para o GitHub Releases..." -ForegroundColor Cyan

function Upload-Asset {
    param(
        [string]$FilePath,
        [string]$ContentType,
        [string]$FileName
    )

    if (-not (Test-Path $FilePath)) {
        Write-Host "[AVISO] Arquivo não encontrado: $FilePath" -ForegroundColor Yellow
        return
    }

    Write-Host "    -> Upload de $FileName ($((Get-Item $FilePath).Length) bytes)..." -ForegroundColor Gray
    
    try {
        $assets = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/$releaseId/assets" -Headers $headers -Method Get
        $existingAsset = $assets | Where-Object { $_.name -eq $FileName }
        if ($existingAsset) {
            Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/assets/$($existingAsset.id)" -Headers $headers -Method Delete
        }
    } catch {}

    $uploadUri = "https://uploads.github.com/repos/$owner/$repo/releases/$releaseId/assets?name=$FileName"
    $fileBytes = [System.IO.File]::ReadAllBytes($FilePath)

    $uploadHeaders = @{
        "Authorization"  = "Bearer $token"
        "Content-Type"   = $ContentType
        "User-Agent"     = "NEXUS-Release-Bot"
    }

    $uploaded = Invoke-RestMethod -Uri $uploadUri -Headers $uploadHeaders -Method Post -Body $fileBytes
    Write-Host "    [OK] $FileName enviado com sucesso!" -ForegroundColor Green
}

Upload-Asset -FilePath $latestJsonPath -ContentType "application/json" -FileName "latest.json"
Upload-Asset -FilePath $setupSig.FullName -ContentType "text/plain" -FileName $setupSig.Name
Upload-Asset -FilePath $setupExe.FullName -ContentType "application/vnd.microsoft.portable-executable" -FileName $setupExe.Name
Upload-Asset -FilePath $releaseExe -ContentType "application/vnd.microsoft.portable-executable" -FileName "nexus.exe"

Write-Host "==================================================" -ForegroundColor Green
Write-Host "   Release $tag publicado com sucesso!            " -ForegroundColor Green
Write-Host "   URL: $($release.html_url)                      " -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host "Os clientes NEXUS em execução detectarão a atualização automaticamente via latest.json!" -ForegroundColor Cyan
