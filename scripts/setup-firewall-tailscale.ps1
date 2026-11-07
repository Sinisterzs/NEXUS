# NEXUS - Configuração do Windows Defender Firewall para Tailscale
# Permite porta 3001 ESTRITAMENTE para tráfego Tailscale (100.64.0.0/10) e Loopback (127.0.0.1)
# NUNCA abre a porta para redes locais domésticas (LocalSubnet) ou internet pública.
$ErrorActionPreference = "Stop"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "   NEXUS Server - Regra de Firewall Tailscale" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

$ruleName = "NEXUS Server (Tailscale Interface Only)"

# Remove regra anterior se existir
Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

try {
    # Cria regra restrita estritamente ao bloco CGNAT da Tailscale (100.64.0.0/10) e loopback
    New-NetFirewallRule -DisplayName $ruleName `
        -Direction Inbound `
        -LocalPort 3001 `
        -Protocol TCP `
        -Action Allow `
        -RemoteAddress @("100.64.0.0/10", "127.0.0.1") `
        -Description "Permite conexões ao backend NEXUS exclusivamente através da rede privada Tailscale e localhost." | Out-Null

    Write-Host "[OK] Regra de Firewall '$ruleName' configurada com sucesso!" -ForegroundColor Green
    Write-Host "     - Porta: 3001 (TCP)" -ForegroundColor DarkGray
    Write-Host "     - Escopo Permitido: 100.64.0.0/10 (Tailscale) e 127.0.0.1 (Localhost)" -ForegroundColor DarkGray
    Write-Host "     - Redes Domésticas (Wi-Fi/LAN) e Internet: BLOQUEADAS" -ForegroundColor DarkGray
} catch {
    Write-Host "[AVISO] Requer privilégios de Administrador para modificar o Firewall do Windows." -ForegroundColor Yellow
    Write-Host "        Execute este script em uma janela do PowerShell como Administrador:" -ForegroundColor DarkGray
    Write-Host "        Start-Process powershell -Verb RunAs -ArgumentList `"-ExecutionPolicy Bypass -File `"$PSCommandPath`"`"" -ForegroundColor DarkGray
}
