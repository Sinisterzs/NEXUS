param([switch]$Generate)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$labRoot = Join-Path $workspace '.nexus-lab'
. (Join-Path $PSScriptRoot 'lab-common.ps1')
Assert-LabTree
$records = Get-Content (Join-Path $labRoot 'processes.json') -Raw | ConvertFrom-Json
$backend = @($records | Where-Object Role -eq 'backend')[-1]
$process = Get-Process -Id $backend.Id
if ($process.Path -ne (Join-Path $labRoot 'target\debug\nexus-server.exe') -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $backend.Start) { throw 'Owned lab backend required' }
$pattern = '^\s*TCP\s+127\.0\.0\.1:13001\s+\S+\s+\S+\s+' + $backend.Id + '\s*$'
if (-not (@(& netstat.exe -ano -p tcp) -match $pattern)) { throw 'Lab backend does not own loopback port' }
$ids = @()
foreach ($profile in @('A','B')) {
    $credentialFile = Join-Path $labRoot "account-$profile.clixml"
    $username = "nexus_lab_$($profile.ToLowerInvariant())"
    if (-not (Test-Path -LiteralPath $credentialFile)) {
        if ($Generate) {
            $bytes = New-Object byte[] 24
            $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
            $secret = ConvertTo-SecureString ([Convert]::ToBase64String($bytes)) -AsPlainText -Force
        } else { $secret = Read-Host "New LOCAL password for $username (8+ characters)" -AsSecureString }
        $credential = New-Object Management.Automation.PSCredential($username, $secret)
        $payload = @{ username=$username; email="$username@example.test"; display_name="LAB $profile"; password=$credential.GetNetworkCredential().Password } | ConvertTo-Json
        $registered = Invoke-RestMethod -Uri 'http://127.0.0.1:13001/v1/auth/register' -Method Post -ContentType 'application/json' -Body $payload
        try { $credential | Export-Clixml -LiteralPath $credentialFile }
        finally {
            Invoke-RestMethod -Uri 'http://127.0.0.1:13001/v1/auth/logout' -Method Post -Headers @{ Authorization="Bearer $($registered.session_token)" } | Out-Null
            $registered=$null; $payload=$null
        }
    }
    $credential = Import-Clixml -LiteralPath $credentialFile
    $payload = @{ login=$username; password=$credential.GetNetworkCredential().Password } | ConvertTo-Json
    $authenticated = Invoke-RestMethod -Uri 'http://127.0.0.1:13001/v1/auth/login' -Method Post -ContentType 'application/json' -Body $payload
    try { $ids += $authenticated.user.id }
    finally {
        Invoke-RestMethod -Uri 'http://127.0.0.1:13001/v1/auth/logout' -Method Post -Headers @{ Authorization="Bearer $($authenticated.session_token)" } | Out-Null
        $authenticated=$null; $payload=$null; $credential=$null
    }
    Write-Host "Local account ready: $username (password encrypted with Windows DPAPI in account-$profile.clixml)."
}
if ($ids[0] -eq $ids[1]) { throw 'Test accounts must have distinct IDs' }
Write-Host 'PASS: two distinct accounts authenticated through the normal login endpoint; preparation sessions revoked.'
