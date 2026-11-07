# NEXUS - Supervisor de Execução do Servidor Backend & PostgreSQL
# Evita múltiplas instâncias, reinicializações infinitas e monitora logs.
$ErrorActionPreference = "Continue"

$rootDir = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $rootDir "nexus-server"
$logsDir = Join-Path $serverDir "logs"
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
}

$lockFile = Join-Path $logsDir "supervisor.lock"
$logFile = Join-Path $logsDir "nexus-server.log"

function Write-SupervisorLog {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] [$Level] $Message"
    Write-Host $line
    Add-Content -Path $logFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
}

# 1. Trava contra múltiplas instâncias simultâneas
if (Test-Path $lockFile) {
    try {
        $existingPid = Get-Content $lockFile -Raw -ErrorAction SilentlyContinue
        if ($existingPid) {
            $existingPid = [int]$existingPid.Trim()
            $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
            if ($proc) {
                Write-SupervisorLog "Supervisor já está em execução (PID: $existingPid). Encerrando nova chamada para evitar duplicação." "WARN"
                exit 0
            }
        }
    } catch {
        # Lockfile corrompido ou processo inexistente
    }
}

$PID | Out-File -FilePath $lockFile -Force

try {
    Write-SupervisorLog "==================================================" "INFO"
    Write-SupervisorLog "Iniciando NEXUS Server Supervisor (PID: $PID)..." "INFO"

    # 2. Rotação de logs se ultrapassar 10 MB
    if (Test-Path $logFile) {
        $logSize = (Get-Item $logFile).Length
        if ($logSize -gt 10MB) {
            $rotatedFile = Join-Path $logsDir "nexus-server.log.1"
            Remove-Item $rotatedFile -Force -ErrorAction SilentlyContinue
            Move-Item $logFile $rotatedFile -Force -ErrorAction SilentlyContinue
            Write-SupervisorLog "Arquivo de log anterior rotacionado para nexus-server.log.1" "INFO"
        }
    }

    # 3. Função para garantir que PostgreSQL esteja ativo
    function Ensure-PostgresRunning {
        $pgPort = 5432
        $pgConn = Get-NetTCPConnection -LocalPort $pgPort -State Listen -ErrorAction SilentlyContinue
        if (-not $pgConn) {
            Write-SupervisorLog "PostgreSQL não detectado na porta 5432. Tentando inicializar..." "INFO"
            $localPgCtl = Join-Path $rootDir ".postgres\pgsql\bin\pg_ctl.exe"
            $localPgData = Join-Path $rootDir ".postgres\data"
            $localPgLog = Join-Path $rootDir ".postgres\pg.log"
            
            if ((Test-Path $localPgCtl) -and (Test-Path $localPgData)) {
                # Limpa postmaster.pid se órfão
                $pidFile = Join-Path $localPgData "postmaster.pid"
                if (Test-Path $pidFile) {
                    $stalePid = (Get-Content $pidFile)[0].Trim()
                    $proc = Get-Process -Id $stalePid -ErrorAction SilentlyContinue
                    if (-not $proc) {
                        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
                    }
                }

                Start-Process -FilePath $localPgCtl -ArgumentList "-D `"$localPgData`" -l `"$localPgLog`" start" -NoNewWindow
                Write-SupervisorLog "Comando de inicialização do PostgreSQL disparado via pg_ctl." "INFO"

                # Aguarda até 10 segundos
                $retries = 10
                while ($retries -gt 0 -and (-not (Get-NetTCPConnection -LocalPort $pgPort -State Listen -ErrorAction SilentlyContinue))) {
                    Start-Sleep -Seconds 1
                    $retries--
                }

                if (Get-NetTCPConnection -LocalPort $pgPort -State Listen -ErrorAction SilentlyContinue) {
                    Write-SupervisorLog "PostgreSQL ativo e respondendo na porta 5432." "OK"
                } else {
                    Write-SupervisorLog "PostgreSQL demorou para inicializar. Verifique .postgres/pg.log." "WARN"
                }
            } else {
                Write-SupervisorLog "PostgreSQL local (.postgres) não encontrado. Certifique-se de que o serviço PostgreSQL esteja ativo." "WARN"
            }
        }
    }

    Ensure-PostgresRunning

    # 4. Localiza executável do nexus-server
    $exePath = Join-Path $serverDir "target\release\nexus-server.exe"
    $useCargo = $false
    if (-not (Test-Path $exePath)) {
        $debugExe = Join-Path $serverDir "target\debug\nexus-server.exe"
        if (Test-Path $debugExe) {
            $exePath = $debugExe
        } else {
            $useCargo = $true
        }
    }

    Write-SupervisorLog "Executável alvo do backend: $(if ($useCargo) { 'cargo run (fallback)' } else { $exePath })" "INFO"

    # 5. Loop do Supervisor com Proteção Contra Crash-Loop
    $restartHistory = @()
    $running = $true

    while ($running) {
        # Limpa histórico de falhas com mais de 60 segundos
        $now = Get-Date
        $restartHistory = @($restartHistory | Where-Object { $_ -gt $now.AddSeconds(-60) })

        if ($restartHistory.Count -ge 5) {
            Write-SupervisorLog "ALERTA: Mais de 5 falhas no backend em 60 segundos. Pausando reinicializações por 60s para proteger o sistema." "ERROR"
            Start-Sleep -Seconds 60
            $restartHistory = @()
        }

        Ensure-PostgresRunning
        Write-SupervisorLog "Disparando processo do servidor NEXUS..." "INFO"

        $process = $null
        if ($useCargo) {
            $process = Start-Process -FilePath "cargo" -ArgumentList "run", "--manifest-path", "$serverDir\Cargo.toml" -WorkingDirectory $rootDir -RedirectStandardOutput (Join-Path $logsDir "stdout.log") -RedirectStandardError (Join-Path $logsDir "stderr.log") -NoNewWindow -PassThru
        } else {
            $process = Start-Process -FilePath $exePath -WorkingDirectory $rootDir -RedirectStandardOutput (Join-Path $logsDir "stdout.log") -RedirectStandardError (Join-Path $logsDir "stderr.log") -NoNewWindow -PassThru
        }

        if ($process) {
            Write-SupervisorLog "Processo nexus-server em execução (PID: $($process.Id))." "OK"
            $process.WaitForExit()
            $exitCode = $process.ExitCode
            Write-SupervisorLog "nexus-server encerrou com código de saída $exitCode." "WARN"
        } else {
            Write-SupervisorLog "Falha ao iniciar processo do servidor." "ERROR"
            Start-Sleep -Seconds 5
        }

        $restartHistory += (Get-Date)
        Write-SupervisorLog "Aguardando 3 segundos antes de reiniciar processo..." "INFO"
        Start-Sleep -Seconds 3
    }
}
finally {
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    Write-SupervisorLog "NEXUS Server Supervisor finalizado e lock removido." "INFO"
}
