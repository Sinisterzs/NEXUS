param([switch]$Live)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$labRoot = Join-Path $workspace '.nexus-lab'
. (Join-Path $PSScriptRoot 'lab-common.ps1')
Assert-LabTree
$errorsFound = $null
[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'lab.ps1'), [ref]$null, [ref]$errorsFound) | Out-Null
if ($errorsFound.Count -gt 0) { throw ($errorsFound | Out-String) }
if (-not $Live) { Write-Host 'PowerShell syntax OK. Use -Live with A and B running for isolation checks.'; exit }
$records = Get-Content (Join-Path $labRoot 'processes.json') -Raw | ConvertFrom-Json
$snapshots = @()
foreach ($profile in @('A','B')) {
    $snapshot = Get-Content (Join-Path $labRoot "$profile\runtime.json") -Raw | ConvertFrom-Json
    if ($snapshot.identifier -ne "com.nexus.testlab.$($profile.ToLowerInvariant())" -or $snapshot.api -ne 'http://127.0.0.1:13001') { throw 'Wrong lab identity or API' }
    if ($snapshot.keyringService -ne "nexus_testlab_$profile") { throw 'Wrong credential namespace' }
    foreach ($field in @('appData','appLocalData','sqlite','webview')) {
        if (-not ([IO.Path]::GetFullPath($snapshot.$field)).StartsWith((Join-Path $labRoot $profile) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "$field escapes profile $profile" }
    }
    $record = @($records | Where-Object { $_.Role -eq "client-$profile" -and $_.Id -eq $snapshot.pid })
    if ($record.Count -ne 1) { throw 'Missing client process' }
    $process = Get-Process -Id $snapshot.pid
    if ($process.Path -ne $record[0].Path -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $record[0].Start) { throw 'Client process mismatch' }
    if (-not (Test-Path -LiteralPath $snapshot.sqlite)) { throw 'Missing isolated SQLite file' }
    $webviewProcesses = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($snapshot.webview)
    })
    if ($webviewProcesses.Count -eq 0) { throw "No WebView2 process using the isolated $profile profile" }
    $snapshots += $snapshot
}
if ($snapshots[0].pid -eq $snapshots[1].pid) { throw 'A and B must be separate processes' }
foreach ($pair in @(@(13001,'backend'),@(15432,'postgres'),@(1420,'vite'))) {
    $record = @($records | Where-Object { $_.Role -eq $pair[1] })[-1]
    $pattern = '^\s*TCP\s+127\.0\.0\.1:' + $pair[0] + '\s+\S+\s+\S+\s+' + $record.Id + '\s*$'
    if (-not (@(& netstat.exe -ano -p tcp) -match $pattern)) { throw 'Expected loopback listener/owner missing' }
    $allForPort = @(& netstat.exe -ano -p tcp) -match ('^\s*TCP\s+\S+:' + $pair[0] + '\s+\S+:0\s+')
    foreach ($line in $allForPort) { if ($line -notmatch $pattern) { throw 'Unexpected lab listener or owner' } }

}
$health = Invoke-RestMethod 'http://127.0.0.1:13001/health'
if ($health.status -ne 'ok') { throw 'Backend unhealthy' }
# Probe a harmless sentinel under the same private tree. Never fetch real secrets.
$probe = Join-Path $labRoot 'http-deny-probe.txt'
Set-Content -LiteralPath $probe -Value 'non-sensitive lab probe'
try {
    try { $response = Invoke-WebRequest 'http://127.0.0.1:1420/.nexus-lab/http-deny-probe.txt' -UseBasicParsing; $statusCode=[int]$response.StatusCode }
    catch { if ($_.Exception.Response) { $statusCode=[int]$_.Exception.Response.StatusCode } else { throw } }
    if ($statusCode -ne 403) { throw "Vite private-path protection failed ($statusCode)" }
} finally { Remove-Item -LiteralPath $probe -Force }
Write-Host 'PASS: two live processes, separate identifiers/SQLite/WebView/config/credential namespaces, actual WebView2 profile arguments, loopback-only services, Vite private paths denied.'
Write-Host 'This does not validate audio, screen capture, actual keyring token storage or WebRTC performance.'
