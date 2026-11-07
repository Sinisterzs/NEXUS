Add-Type @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;

public class WinCapture {
    [DllImport("user32.dll", EntryPoint="FindWindow", SetLastError = true)]
    public static extern IntPtr FindWindowByCaption(IntPtr ZeroOnly, string lpWindowName);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBmp, uint nFlags);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    public static Bitmap Capture(IntPtr hwnd) {
        RECT rc;
        GetWindowRect(hwnd, out rc);
        int w = rc.Right - rc.Left;
        int h = rc.Bottom - rc.Top;
        if (w <= 0 || h <= 0) return null;
        Bitmap bmp = new Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(bmp)) {
            IntPtr hdc = g.GetHdc();
            PrintWindow(hwnd, hdc, 2); // PW_RENDERFULLCONTENT = 2
            g.ReleaseHdc(hdc);
        }
        return bmp;
    }
}
"@ -ReferencedAssemblies System.Drawing

$exe = "c:\Users\kelma\Documents\Tropa\src-tauri\target\release\nexus.exe"
$artDir = "C:\Users\kelma\.gemini\antigravity\brain\807e9cb5-c783-4933-a232-b33d2886a8d7"

function Capture-Tab($tabName, $outFile) {
    Write-Host "Capturing tab $tabName..."
    $proc = Start-Process -FilePath $exe -ArgumentList "--tab=$tabName" -PassThru
    Start-Sleep -Seconds 3

    $hWnd = [WinCapture]::FindWindowByCaption([IntPtr]::Zero, "NEXUS")
    if ($hWnd -ne [IntPtr]::Zero) {
        $bmp = [WinCapture]::Capture($hWnd)
        if ($bmp) {
            $bmp.Save("$artDir\$outFile", [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
            Write-Host "Saved $outFile successfully."
        } else {
            Write-Host "Failed to capture bitmap for $outFile"
        }
    } else {
        Write-Host "Could not find NEXUS window for $outFile"
    }

    Stop-Process -Id $proc.Id -Force
    Start-Sleep -Milliseconds 600
}

Capture-Tab "home" "fase1_3_01_home.png"
Capture-Tab "messages" "fase1_3_02_messages.png"
Capture-Tab "communities" "fase1_3_03_communities.png"
Capture-Tab "calls" "fase1_3_04_calls.png"
Capture-Tab "settings" "fase1_3_05_settings.png"

Get-ChildItem "$artDir\fase1_3_*.png" | Select-Object Name, Length
