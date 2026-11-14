param(
  [Parameter(Mandatory=$true)][string]$TransmitterExe,
  [ValidateSet('nvidia','amd')][string]$Vendor='nvidia'
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSCommandPath
$manifest=Get-Content -LiteralPath (Join-Path $root 'probe-package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$transmitterHash=(Get-FileHash -LiteralPath $TransmitterExe -Algorithm SHA256).Hash.ToLowerInvariant()
if($transmitterHash -ne $manifest.expectedTransmitterSha256){throw 'Transmitter does not match the approved SDR local build. Nothing tested.'}
$exe=Join-Path $root 'nexus-color-probe.exe'
$probeHash=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
if($probeHash -ne $manifest.probeSha256){throw 'Probe checksum mismatch'}
$result=Join-Path $root ('range-comparison-'+$Vendor+'-'+[guid]::NewGuid().ToString('N').Substring(0,12))
[void](New-Item -ItemType Directory -Path $result)
$child=$null
try {
  foreach($colorPath in @('legacy','dxgi1')){
    $directory=Join-Path $result $colorPath
    $start=New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName=$exe;$start.Arguments='--vendor '+$Vendor+' --output "'+$directory+'" --color-path '+$colorPath
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $child=New-Object System.Diagnostics.Process;$child.StartInfo=$start
    [void]$child.Start();$stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
    $timedOut=-not $child.WaitForExit(60000)
    if($timedOut){$child.Kill();$child.WaitForExit()}
    $exitCode=$child.ExitCode;$console=$stdout.GetAwaiter().GetResult()+$stderr.GetAwaiter().GetResult()
    $child.Dispose();$child=$null
    if(-not(Test-Path -LiteralPath $directory)){[void](New-Item -ItemType Directory -Path $directory)}
    $console | Set-Content -LiteralPath (Join-Path $directory 'probe-console.txt') -Encoding UTF8
    @{colorPath=$colorPath;vendor=$Vendor;transmitterSha256=$transmitterHash;probeSha256=$probeHash;exitCode=$exitCode;timedOut=$timedOut;captureStarted=$false;audioStarted=$false;peerCreated=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $directory 'identity.json') -Encoding UTF8
    if($exitCode -ne 0){Write-Warning "$colorPath collection incomplete; retaining partial data and testing the other path"}
    Write-Host "$colorPath collected. Exit code does not establish color correctness; return both results for decode and 24-color analysis."
  }
} finally {
  if($null -ne $child){if(-not $child.HasExited){$child.Kill();$child.WaitForExit()};$child.Dispose()}
  $zip=$result+'.zip';Compress-Archive -LiteralPath $result -DestinationPath $zip
  Write-Host "Comparison package: $zip"
}
