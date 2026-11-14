param(
  [Parameter(Mandatory=$true)][string]$TransmitterExe,
  [ValidateSet('nvidia','amd')][string]$Vendor='nvidia'
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSCommandPath
$exe=Join-Path $root 'nexus-color-probe.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'Probe executable missing from extracted package' }
$expected='b468c7d308a7d755c7e73cd403b7489e3e6e1aaf18209a64948c913e76afb03f'
$item=Get-Item -LiteralPath $TransmitterExe
$actual=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
  if ($actual -eq 'e93163bb0a8b1fe1a103a6690a41230fb9ebf1b14a7d2f9b89b81461b23d29e0') { throw 'This is published Nightly.4, which does not include the SDR fix. Nothing tested.' }
  throw "Unrecognized transmitter build SHA-256: $actual. Stop and confirm the build before comparing GPU results."
}
$driverInventory=@()
try { $driverInventory=@(Get-CimInstance Win32_VideoController -ErrorAction Stop | Select-Object Name,DriverVersion) } catch {}
$probeHash=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest=Get-Content -LiteralPath (Join-Path $root 'probe-package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($probeHash -ne $manifest.probeSha256) { throw 'Probe checksum mismatch' }
$directory=Join-Path $root ('result-'+$Vendor+'-'+[guid]::NewGuid().ToString('N').Substring(0,12))
$processVisible=$null
try { $processVisible=[bool](Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $item.FullName } | Select-Object -First 1) } catch {}
$startInfo=New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName=$exe
$startInfo.Arguments='--vendor '+$Vendor+' --output "'+$directory+'"'
$startInfo.UseShellExecute=$false
$startInfo.CreateNoWindow=$true
$startInfo.RedirectStandardOutput=$true
$startInfo.RedirectStandardError=$true
$probe=New-Object System.Diagnostics.Process
$probe.StartInfo=$startInfo
[void]$probe.Start()
$stdout=$probe.StandardOutput.ReadToEndAsync()
$stderr=$probe.StandardError.ReadToEndAsync()
$timedOut=-not $probe.WaitForExit(60000)
if ($timedOut) { $probe.Kill(); $probe.WaitForExit() }
$probeExit=$probe.ExitCode
$console=$stdout.GetAwaiter().GetResult()+$stderr.GetAwaiter().GetResult()
$probe.Dispose()
if (Test-Path -LiteralPath $directory) { $console | Set-Content -LiteralPath (Join-Path $directory 'probe-console.txt') -Encoding UTF8 }
if ($timedOut) { Write-Warning 'Only the temporary probe was stopped after 60 seconds; no personal app was closed.' }
if (-not (Test-Path -LiteralPath $directory)) { throw 'Probe did not create an output directory' }
@{ executableFileName=$item.Name; productVersion=$item.VersionInfo.ProductVersion; transmitterSha256=$actual; expectedSdrBuild=$true; matchingProcessObserved=$processVisible; probeSha256=$probeHash; probeExitCode=$probeExit; probeTimedOut=$timedOut; driverInventory=$driverInventory } |
 ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $directory 'build-identity.json') -Encoding UTF8
$archive=$directory+'.zip'
Compress-Archive -LiteralPath $directory -DestinationPath $archive
Write-Host "Synthetic result package: $archive"
if ($probeExit -ne 0) { throw 'Collection incomplete. Keep the result ZIP, inspect the error, and do not infer NVIDIA measurements from another GPU.' }
Write-Host 'Collection finished. Return the result ZIP for independent decode/analysis. No screen/audio/peer was opened.'
