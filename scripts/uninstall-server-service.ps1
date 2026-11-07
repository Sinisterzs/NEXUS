# NEXUS - Desinstalação da Inicialização Automática do Servidor
$ErrorActionPreference = "Continue"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "   NEXUS Server - Remoção de Autostart Windows" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

$taskName = "NexusServerTask"

# 1. Encerra a tarefa agendada
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

# 2. Desregistra a tarefa
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "[OK] Tarefa Agendada '$taskName' desregistrada." -ForegroundColor Green

# 3. Finaliza processos remanescentes se necessário
$procs = Get-Process -Name "nexus-server" -ErrorAction SilentlyContinue
if ($procs) {
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] Processos nexus-server finalizados." -ForegroundColor Green
}

$rootDir = Split-Path -Parent $PSScriptRoot
$lockFile = Join-Path $rootDir "nexus-server\logs\supervisor.lock"
Remove-Item $lockFile -Force -ErrorAction SilentlyContinue

Write-Host "Serviço automático removido com sucesso." -ForegroundColor Green
