$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$directory = Join-Path $root 'scratch\p2p-four-users\export-test'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$source = Join-Path $directory 'capture.log'
$output = Join-Path $directory 'sanitized.json'
$record = @{
    senderToken = ('a' * 64); offerToken = ('b' * 64); peerToken = 'PRIVATE_ID'
    connectionState = 'connecting'; dtlsState = 'PRIVATE_STATE'; iceApplied = 9; iceRejected = -1
    failureCode = 'ice_failed'; terminationKind = 'failed'; attemptElapsedMs = 15000
    closureCode = 'PRIVATE_REASON'; local_ipv4 = 2; local_udp = 2
    credential = 'PRIVATE_CREDENTIAL'; address = 'PRIVATE_ADDRESS'; sdp = 'PRIVATE_SDP'
    traffic = @{ rtp_blocked = 10; rtp_forwarded_bytes = 0; address = 'PRIVATE_NESTED' }
    localNegotiation = @{ setup = 'actpass'; iceCredentialsPresent = $true; password = 'PRIVATE_PASSWORD' }
}
$line = '[2026-11-14 17:30:00.000Z] [CAPTURE] screen_receiver ' + ($record | ConvertTo-Json -Compress -Depth 5)
# Include a rotated file, concatenated records, malformed JSON and an out-of-window record.
Set-Content -LiteralPath ($source + '.1') -Value $line -Encoding UTF8
Set-Content -LiteralPath $source -Value ($line + '[2026-11-14 17:31:00.000Z] [CAPTURE] screen_transport {BROKEN}' +
    '[2026-11-14 18:30:00.000Z] [CAPTURE] screen_receiver {"iceApplied":100}') -Encoding UTF8
& (Join-Path $root 'scripts\Export-ScreenP2PDiagnostics.ps1') -Alias CasaA -Start '2026-11-14T14:29:00-03:00' -End '2026-11-14T14:32:00-03:00' -LogPath $source -OutputPath $output
$raw = Get-Content -LiteralPath $output -Raw
if ($raw.Contains('PRIVATE')) { throw 'Export leaked forbidden fields or invalid values.' }
$result = $raw | ConvertFrom-Json
if ($result.records.Count -ne 2 -or $result.invalidRecords -ne 1) { throw 'Rotation, window or parsing regression.' }
$snapshot = $result.records[0].snapshot
if ($snapshot.iceApplied -ne 9 -or $snapshot.traffic.rtp_blocked -ne 10 -or
    $snapshot.failureCode -ne 'ice_failed' -or $snapshot.localNegotiation.setup -ne 'actpass' -or
    $snapshot.senderToken -ne ('a' * 64) -or $snapshot.attemptElapsedMs -ne 15000) { throw 'Allowed diagnostic data was lost.' }
if ($snapshot.PSObject.Properties.Name -contains 'iceRejected') { throw 'Negative counter escaped.' }
Write-Output 'PASS: sanitizer, rotation, time window, nested data and malformed records.'
