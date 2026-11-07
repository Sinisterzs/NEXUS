# NEXUS - Verificação de Dependências e Configurações Locais
$ErrorActionPreference = "Continue"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   NEXUS - Verificação de Dependências" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$allGood = $true

# 1. Node.js & NPM
try {
    $nodeVer = & node -v
    $npmVer = & npm -v
    Write-Host "[OK] Node.js ($nodeVer) e NPM ($npmVer) instalados." -ForegroundColor Green
} catch {
    Write-Host "[ERRO] Node.js não foi encontrado no PATH do sistema." -ForegroundColor Red
    $allGood = $false
}

# 2. Rust & Cargo
try {
    $rustcVer = & rustc --version
    $cargoVer = & cargo --version
    Write-Host "[OK] $rustcVer e $cargoVer instalados." -ForegroundColor Green
} catch {
    Write-Host "[ERRO] Rust/Cargo não encontrado no PATH. Adicione `%USERPROFILE%\.cargo\bin`." -ForegroundColor Red
    $allGood = $false
}

# 3. PostgreSQL na porta 5432
$pgConn = Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue
if ($pgConn) {
    Write-Host "[OK] PostgreSQL ativo e escutando na porta 5432." -ForegroundColor Green
} else {
    Write-Host "[ALERTA] PostgreSQL não detectado na porta 5432." -ForegroundColor Yellow
    Write-Host "         Para desenvolvimento local com autenticação, inicie o PostgreSQL." -ForegroundColor DarkGray
    Write-Host "         O modo SQLite local continuará funcionando normalmente." -ForegroundColor DarkGray
}

# 4. Configuração OAuth e Backend (nexus.config.json)
$configPath = Join-Path $PSScriptRoot "..\nexus.config.json"
if (Test-Path $configPath) {
    $configContent = Get-Content $configPath -Raw | ConvertFrom-Json
    $clientId = $configContent.googleClientId
    $apiUrl = $configContent.apiUrl
    if ($clientId -and $clientId.Length -gt 10) {
        $maskedId = $clientId.Substring(0, [Math]::Min(16, $clientId.Length)) + "..."
        Write-Host "[OK] nexus.config.json carregado: Google Client ID ($maskedId), API ($apiUrl)." -ForegroundColor Green
    } else {
        Write-Host "[AVISO] nexus.config.json existe mas googleClientId está vazio." -ForegroundColor Yellow
    }
} else {
    Write-Host "[ERRO] Arquivo nexus.config.json não encontrado na raiz do projeto." -ForegroundColor Red
    $allGood = $false
}

# 5. Configuração do Backend (nexus-server/.env)
$serverEnvPath = Join-Path $PSScriptRoot "..\nexus-server\.env"
if (Test-Path $serverEnvPath) {
    $envLines = Get-Content $serverEnvPath
    $serverClientId = ""
    $hasSecret = $false
    foreach ($line in $envLines) {
        if ($line -match "^GOOGLE_CLIENT_ID=(.+)$") {
            $serverClientId = $matches[1].Trim()
        }
        if ($line -match "^GOOGLE_CLIENT_SECRET=(.+)$") {
            if ($matches[1].Trim().Length -gt 0) {
                $hasSecret = $true
            }
        }
    }
    if ($serverClientId -and $serverClientId.Length -gt 10) {
        $maskedServerId = $serverClientId.Substring(0, [Math]::Min(16, $serverClientId.Length)) + "..."
        Write-Host "[OK] nexus-server/.env possui GOOGLE_CLIENT_ID configurado ($maskedServerId)." -ForegroundColor Green

        # Comparar com nexus.config.json
        if ($configContent -and $configContent.googleClientId -eq $serverClientId) {
            Write-Host "[OK] Cliente Desktop e Servidor Backend utilizam o MESMO Client ID." -ForegroundColor Green
        } else {
            Write-Host "[AVISO] Client ID divergente entre nexus.config.json e nexus-server/.env!" -ForegroundColor Yellow
        }
    } else {
        Write-Host "[AVISO] GOOGLE_CLIENT_ID ausente no nexus-server/.env." -ForegroundColor Yellow
    }

    if ($hasSecret) {
        Write-Host "[OK] nexus-server/.env: GOOGLE_CLIENT_SECRET carregado: verdadeiro." -ForegroundColor Green
    } else {
        Write-Host "[AVISO] nexus-server/.env: GOOGLE_CLIENT_SECRET carregado: falso." -ForegroundColor Yellow
    }
} else {
    Write-Host "[AVISO] nexus-server/.env não encontrado." -ForegroundColor Yellow
}

Write-Host "----------------------------------------" -ForegroundColor Cyan
if ($allGood) {
    Write-Host "Ambiente pronto para desenvolvimento e build!" -ForegroundColor Green
} else {
    Write-Host "Verifique os alertas acima antes de prosseguir." -ForegroundColor Yellow
}
