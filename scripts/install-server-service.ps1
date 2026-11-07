# NEXUS - Instalação da Inicialização Automática do Servidor no Windows
$ErrorActionPreference = "Stop"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "   NEXUS Server - Instalação de Autostart Windows" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

$rootDir = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $rootDir "nexus-server"
$supervisorScript = Join-Path $PSScriptRoot "nexus-server-supervisor.ps1"
$taskName = "NexusServerTask"

# 1. Encerra instâncias em execução para liberar o arquivo binário
Write-Host "[INFO] Parando qualquer serviço ou processo ativo do nexus-server..." -ForegroundColor Yellow
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

$runningProcs = Get-Process -Name "nexus-server" -ErrorAction SilentlyContinue
if ($runningProcs) {
    $runningProcs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

# Remove lock do supervisor anterior
$lockFile = Join-Path $serverDir "logs\supervisor.lock"
Remove-Item $lockFile -Force -ErrorAction SilentlyContinue

# 2. Compila o binário de produção Release atualizado
Write-Host "[INFO] Compilando nexus-server em modo Release com bind duplo (Loopback + Tailscale)..." -ForegroundColor Yellow
& cargo build --release --manifest-path (Join-Path $serverDir "Cargo.toml")
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERRO] Falha ao compilar nexus-server." -ForegroundColor Red
    exit 1
}
Write-Host "[OK] nexus-server Release compilado com sucesso." -ForegroundColor Green

# 3. Configura a Tarefa Agendada no Windows
Write-Host "[INFO] Registrando Tarefa Agendada '$taskName'..." -ForegroundColor Yellow

# Ação: Executa o supervisor em segundo plano sem janela
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$supervisorScript`""

# Gatilho: No logon do usuário atual
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Configurações de resiliência e energia
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 365) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

# Se já existe e falhar com acesso negado, mantém a tarefa configurada
try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force -Description "NEXUS Server & PostgreSQL Background Supervisor" | Out-Null
    Write-Host "[OK] Tarefa Agendada '$taskName' registrada com sucesso." -ForegroundColor Green
} catch {
    Write-Host "[INFO] Tarefa Agendada '$taskName' já existente mantida." -ForegroundColor Yellow
}

# 3. Dispara a tarefa agora
Write-Host "[INFO] Iniciando serviço do servidor agora..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

Write-Host "--------------------------------------------------" -ForegroundColor Cyan
Write-Host "Servidor configurado para inicializar automaticamente com o Windows." -ForegroundColor Green
Write-Host "Logs do servidor disponíveis em: nexus-server\logs\nexus-server.log" -ForegroundColor DarkGray
