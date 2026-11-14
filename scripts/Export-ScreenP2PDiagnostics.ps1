param(
    [Parameter(Mandatory=$true)][ValidateSet('Eu','CasaA','CasaB','Quarto')][string]$Alias,
    [Parameter(Mandatory=$true)][DateTimeOffset]$Start,
    [Parameter(Mandatory=$true)][DateTimeOffset]$End,
    [string]$LogPath = (Join-Path $env:APPDATA 'com.nexus.desktop\capture.log'),
    [string]$OutputPath = (Join-Path (Get-Location) 'screen-p2p-sanitized.json')
)
$ErrorActionPreference = 'Stop'
if ($End -le $Start) { throw 'O fim precisa ser posterior ao inicio.' }

# Strict allowlist: never copy free text, addresses, SDP, credentials or raw IDs.
$numbers = @(
    'packetsReceived','bytesReceived','framesReceived','framesDecoded','keyFramesDecoded','framesDropped',
    'receiverId','receiverGeneration','roomGeneration','offersApplied','answersSent','iceQueued','iceApplied','iceRejected','iceStale',
    'icePairs','icePairsWaiting','icePairsInProgress','icePairsSucceeded','icePairsFailed','iceNominatedPairs',
    'iceRequestsSentTotal','iceRequestsReceivedTotal','iceResponsesSentTotal','iceResponsesReceivedTotal','iceConsentRequestsSentTotal',
    'iceRequestsSent','iceRequestsReceived','iceResponsesSent','iceResponsesReceived',
    'pairRequestsSent','pairRequestsReceived','pairResponsesSent','pairResponsesReceived','pairConsentRequestsSent','pairBytesSent','pairBytesReceived',
    'iceConnectedObservedMs','dtlsConnectingObservedMs','attemptElapsedMs','offerAppliedMs','answerSentMs','directReadyMs','firstTrackMs',
    'roundTripTime','packetsLost','jitter','nackCount','pliCount','firCount','totalDecodeTime',
    'playerReadyState','playerWidth','playerHeight','playerCurrentTime',
    'local_host','local_srflx','local_relay','remote_host','remote_srflx','remote_relay',
    'local_udp','local_tcp','remote_udp','remote_tcp','local_ipv4','local_ipv6','local_mdns','local_unknown',
    'remote_ipv4','remote_ipv6','remote_mdns','remote_unknown',
    'rtp_blocked','rtp_forwarded_writes','rtp_forwarded_bytes','rtp_write_errors',
    'rtcp_blocked','rtcp_forwarded_writes','rtcp_forwarded_bytes','rtcp_write_errors'
)
$booleans = @('pairNominated','setupCompatible','localSdpPresent','remoteSdpPresent',
    'localIceCredentialsPresent','remoteIceCredentialsPresent','localFingerprintPresent','remoteFingerprintPresent',
    'localFingerprintMatchesCertificate','remoteFingerprintMatchesCertificate','playerBound','playerPaused','trackMuted',
    'iceCheckCountersAvailable','sdpPresent','iceCredentialsPresent','fingerprintPresent')
$enums = @{
    connectionState = @('new','connecting','connected','disconnected','failed','closed')
    iceConnectionState = @('new','checking','connected','completed','disconnected','failed','closed')
    iceState = @('new','checking','connected','completed','disconnected','failed','closed')
    signalingState = @('stable','have-local-offer','have-remote-offer','have-local-pranswer','have-remote-pranswer','closed')
    iceGatheringState = @('new','gathering','complete')
    dtlsState = @('new','connecting','connected','closed','failed')
    pairState = @('frozen','waiting','in-progress','failed','succeeded')
    localCandidateType = @('host','srflx','prflx','relay')
    remoteCandidateType = @('host','srflx','prflx','relay')
    localSetup = @('active','passive','actpass'); remoteSetup = @('active','passive','actpass'); setup = @('active','passive','actpass')
    timeoutPhase = @('ice_pair','secure_transport')
    terminationKind = @('failed','closed')
    closureCode = @('participant_left','room_left','remote_stopped','requested_stop','track_ended','pc_closed','sdp_rejected','candidate_rejected','session_replaced','negotiation_error','failed_cleanup')
    failureCode = @('direct_deadline','stats_stalled','pc_failed','ice_failed','relay_selected','retry_no_offer','connected_no_frames')
}
function Get-SafeSnapshot($value, [bool]$Nested = $false) {
    $safe = [ordered]@{}
    foreach ($property in $value.PSObject.Properties) {
        $key = $property.Name; $v = $property.Value
        if ($key -in $numbers) {
            if ($null -eq $v -or (($v -is [ValueType]) -and ($v -isnot [bool]) -and
                [double]::TryParse([string]$v, [ref]([double]0)) -and [double]$v -ge 0 -and
                -not [double]::IsInfinity([double]$v) -and -not [double]::IsNaN([double]$v))) { $safe[$key] = $v }
        } elseif ($key -in $booleans) {
            if ($null -eq $v -or $v -is [bool]) { $safe[$key] = $v }
        } elseif ($enums.ContainsKey($key)) {
            if ($null -eq $v -or ($v -is [string] -and $v -cin $enums[$key])) { $safe[$key] = $v }
        } elseif ($key -in @('senderToken','peerToken','transportToken','offerToken','diagnosticRun')) {
            $length = if ($key -eq 'diagnosticRun') { 32 } else { 64 }
            if ($v -is [string] -and $v -cmatch ('^[a-fA-F0-9]{' + $length + '}$')) { $safe[$key] = $v }
        } elseif (-not $Nested -and $key -in @('traffic','localNegotiation','remoteNegotiation')) {
            $safe[$key] = Get-SafeSnapshot $v $true
        }
    }
    return $safe
}
$raw = ''
foreach ($source in @(($LogPath + '.1'), $LogPath)) {
    if (Test-Path -LiteralPath $source) { $raw += [IO.File]::ReadAllText((Resolve-Path -LiteralPath $source)) + "`n" }
}
if (-not $raw) { throw 'Nenhum capture.log encontrado no caminho informado.' }
$records = @(); $invalid = 0
# Split concatenated log messages before parsing JSON. Raw text is never exported.
foreach ($segment in [regex]::Split($raw, '(?=\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z\])')) {
    if ($segment -notmatch '^\[(?<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z)\]\s+\[CAPTURE\]\s+(?<kind>screen_receiver|screen_transport)\s+(?<json>\{[^\r\n]*\})') { continue }
    $timestamp = [DateTimeOffset]::Parse($Matches.time, [Globalization.CultureInfo]::InvariantCulture)
    if ($timestamp -lt $Start -or $timestamp -gt $End) { continue }
    $kind = $Matches.kind; $json = $Matches.json
    try { $value = ConvertFrom-Json -InputObject $json } catch { $invalid++; continue }
    $records += [ordered]@{ timestampUtc = $timestamp.ToUniversalTime().ToString('o'); kind = $kind; snapshot = (Get-SafeSnapshot $value) }
}
$result = [ordered]@{ schemaVersion = 1; machineAlias = $Alias;
    startUtc = $Start.ToUniversalTime().ToString('o'); endUtc = $End.ToUniversalTime().ToString('o');
    invalidRecords = $invalid; records = @($records) }
$destination = [IO.Path]::GetFullPath($OutputPath)
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $destination -Encoding UTF8
Write-Output ("Exportados {0} registros anonimizados; invalidos: {1}. Arquivo: {2}" -f $records.Count, $invalid, $destination)
