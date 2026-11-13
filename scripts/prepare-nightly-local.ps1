param([string]$OutputDirectory = "scratch/nightly4-preparation/distribution")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$config = Get-Content -LiteralPath src-tauri/tauri.conf.json -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.version -notmatch '^\d+\.\d+\.\d+-nightly\.\d+$') { throw 'Nightly version required' }
$destination = [IO.Path]::GetFullPath((Join-Path $root $OutputDirectory))
if (-not $destination.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must remain within the workspace' }
if ((Test-Path -LiteralPath $destination) -and (Get-ChildItem -LiteralPath $destination -Force | Select-Object -First 1)) { throw 'Use an empty output directory to avoid mixing builds' }
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$savedKey = $env:TAURI_SIGNING_PRIVATE_KEY
$savedPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
try {
  if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)) {
    $keyPath = Join-Path $root '.tauri/nexus.key'
    if (-not (Test-Path -LiteralPath $keyPath)) { throw 'Local signing key unavailable' }
    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -LiteralPath $keyPath -Raw
  }
  if ($null -eq $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '' }
  & node node_modules/@tauri-apps/cli/tauri.js build --bundles nsis -- --offline --locked
  if ($LASTEXITCODE -ne 0) { throw 'Tauri NSIS build/signing failed' }
  $productVersion = (Get-Item -LiteralPath src-tauri/target/release/nexus.exe).VersionInfo.ProductVersion
  if ($productVersion -ne $config.version) { throw 'Desktop binary version does not match the requested Nightly' }
  $name = "nexus_$($config.version)_x64-setup.exe"
  Copy-Item -LiteralPath src-tauri/target/release/nexus.exe -Destination (Join-Path $destination 'nexus.exe')
  foreach ($file in @($name, "$name.sig")) {
    Copy-Item -LiteralPath (Join-Path $root "src-tauri/target/release/bundle/nsis/$file") -Destination (Join-Path $destination $file)
  }
  $notes = Get-Content -LiteralPath "scripts/release-notes-v$($config.version).md" -Raw -Encoding UTF8
  $manifestPath = Join-Path $destination 'latest-nightly.json'
  & node scripts/generate-nightly-manifest.cjs $config.version $notes $manifestPath
  if ($LASTEXITCODE -ne 0) { throw 'Local Nightly manifest failed' }
  & node scripts/audit-nightly-artifacts.cjs $manifestPath
  if ($LASTEXITCODE -ne 0) { throw 'Artifact audit failed' }
  & node scripts/verify-nightly-distribution.cjs $destination
  if ($LASTEXITCODE -ne 0) { throw 'Cryptographic verification failed' }
  Write-Host 'Local preparation complete. Nothing was installed, pushed or published.'
} finally {
  $env:TAURI_SIGNING_PRIVATE_KEY = $savedKey
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $savedPassword
}
