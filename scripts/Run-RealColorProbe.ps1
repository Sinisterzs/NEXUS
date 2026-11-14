param(
  [Parameter(Mandatory=$true)][string]$TransmitterExe,
  [ValidateSet('nvidia','amd')][string]$Vendor='nvidia',
  [int]$ScreenIndex=0
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSCommandPath
$exe=Join-Path $root 'nexus-color-probe.exe'
$manifest=Get-Content -LiteralPath (Join-Path $root 'probe-package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$transmitter=Get-Item -LiteralPath $TransmitterExe
$hash=(Get-FileHash -LiteralPath $transmitter.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne $manifest.expectedTransmitterSha256) { throw 'Transmitter does not match the approved SDR local build. Nothing captured.' }
if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.probeSha256) { throw 'Probe checksum mismatch' }
$chartPath=Join-Path $root 'reference.bmp'
if ((Get-FileHash -LiteralPath $chartPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.referenceSha256) { throw 'Reference checksum mismatch' }
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public sealed class NexusChartWindow : Form {
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 public Bitmap Chart;
 public NexusChartWindow() { FormBorderStyle=FormBorderStyle.None; AutoScaleMode=AutoScaleMode.None; TopMost=true; ShowInTaskbar=true; Text="NEXUS Synthetic SDR Diagnostic"; ClientSize=new Size(1280,720); StartPosition=FormStartPosition.Manual; }
 protected override void OnPaint(PaintEventArgs e) { if(Chart!=null) e.Graphics.DrawImageUnscaled(Chart,(ClientSize.Width-1280)/2,(ClientSize.Height-720)/2); }
 protected override void OnPaintBackground(PaintEventArgs e) { e.Graphics.Clear(Color.Black); }
}
'@
$form=$null;$bitmap=$null;$probe=$null
$result=Join-Path $root ('real-result-'+$Vendor+'-'+[guid]::NewGuid().ToString('N').Substring(0,12))
[void](New-Item -ItemType Directory -Path $result)
$oldDpi=[NexusChartWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($oldDpi -eq [IntPtr]::Zero) {throw 'Cannot establish a physical-pixel DPI context'}
try {
  $screens=[System.Windows.Forms.Screen]::AllScreens
  if ($ScreenIndex -lt 0 -or $ScreenIndex -ge $screens.Count) { throw 'Invalid screen index' }
  $bounds=$screens[$ScreenIndex].Bounds
  if ($bounds.Width -lt 1280 -or $bounds.Height -lt 720) { throw 'A monitor with at least 1280x720 physical pixels is required' }
  $bitmap=New-Object System.Drawing.Bitmap($chartPath)
  $form=New-Object NexusChartWindow
  $form.Chart=$bitmap
  $form.Bounds=$bounds
  $form.Show();$form.Activate();$form.Refresh()
  [System.Windows.Forms.Application]::DoEvents()
  Write-Host 'Only the synthetic chart region will be exported. Do not move, cover or switch away from this window. The window closes automatically. No audio/network media is used.'
  $drivers=@();try{$drivers=@(Get-CimInstance Win32_VideoController -ErrorAction Stop | Select-Object Name,DriverVersion)}catch{}
  foreach ($backend in @('dxgi','wgc')) {
    if ($form.IsDisposed) { throw 'Synthetic chart closed; capture cancelled' }
    $form.Activate();$form.Refresh();[System.Windows.Forms.Application]::DoEvents()
    $directory=Join-Path $result $backend
    $start=New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName=$exe
    $start.Arguments='--vendor '+$Vendor+' --output "'+$directory+'" --capture '+$backend+' --window '+$form.Handle.ToInt64()+' --owner '+$PID
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $probe=New-Object System.Diagnostics.Process;$probe.StartInfo=$start
    [void]$probe.Start();$stdout=$probe.StandardOutput.ReadToEndAsync();$stderr=$probe.StandardError.ReadToEndAsync()
    $watch=[System.Diagnostics.Stopwatch]::StartNew();$cancelled=$false
    while (-not $probe.HasExited) {
      [System.Windows.Forms.Application]::DoEvents()
      if ($form.IsDisposed -or $watch.Elapsed.TotalSeconds -gt 60) { $cancelled=$true;$probe.Kill();$probe.WaitForExit();break }
      Start-Sleep -Milliseconds 20
    }
    $exit=$probe.ExitCode
    $console=$stdout.GetAwaiter().GetResult()+$stderr.GetAwaiter().GetResult()
    $probe.Dispose();$probe=$null
    if (-not (Test-Path -LiteralPath $directory)) {[void](New-Item -ItemType Directory -Path $directory)}
    $console | Set-Content -LiteralPath (Join-Path $directory 'probe-console.txt') -Encoding UTF8
    @{backend=$backend;exitCode=$exit;cancelled=$cancelled;transmitterSha256=$hash;probeSha256=$manifest.probeSha256;referenceSha256=$manifest.referenceSha256;driverInventory=$drivers;renderer='WinForms GDI+ DrawImageUnscaled, no embedded ICC, 1:1 physical pixels';dpiContext='PER_MONITOR_AWARE_V2 thread-local';personalMediaRequested=$false} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $directory 'identity.json') -Encoding UTF8
    if ($cancelled) {throw 'Diagnostic cancelled or timed out; only the owned temporary probe was stopped'}
    if ($exit -ne 0) {Write-Warning "$backend collection incomplete; retaining the report and continuing to the other backend"}
  }
} finally {
  if ($null -ne $probe) {if (-not $probe.HasExited){$probe.Kill();$probe.WaitForExit()};$probe.Dispose()}
  if ($null -ne $form) {$form.Dispose()}
  if ($null -ne $bitmap) {$bitmap.Dispose()}
  if ($oldDpi -ne [IntPtr]::Zero) {[void][NexusChartWindow]::SetThreadDpiAwarenessContext($oldDpi)}
  $archive=$result+'.zip'
  Compress-Archive -LiteralPath $result -DestinationPath $archive
  Write-Host "Result package: $archive"
}
