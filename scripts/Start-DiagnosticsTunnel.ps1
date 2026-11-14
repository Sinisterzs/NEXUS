param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9.-]+$')][string]$AwsHost,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$SshUser,
    [Parameter(Mandatory=$true)][string]$KeyPath,
    [ValidateRange(1024,65535)][int]$LocalPort=8080
)
$ErrorActionPreference='Stop'
if(-not(Test-Path -LiteralPath $KeyPath -PathType Leaf)){throw 'Informe a chave SSH existente.'}
$probe=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$LocalPort)
try{$probe.Start()}catch{throw 'Porta local ocupada. Use -LocalPort 18080.'}finally{$probe.Stop()}
Write-Host "Painel: http://localhost:$LocalPort — mantenha esta janela aberta; Ctrl+C encerra o túnel."
# No -g, remote listener, key import, security group or firewall change.
& ssh -i $KeyPath -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 `
    -L "127.0.0.1:${LocalPort}:127.0.0.1:8080" "${SshUser}@${AwsHost}"
