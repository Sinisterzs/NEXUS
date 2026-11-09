# NEXUS - Executor Seguro de Testes com Guard de Registro do Windows
# Impede que qualquer teste de instalador NSIS polua o registro do Windows

param (
    [string]$InstallerPath,
    [string]$TargetDirectory = "$PSScriptRoot\..\test_updater_stage"
)

$ErrorActionPreference = "Stop"

$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\nexus"
$installDirKey = "HKCU:\Software\nexus"

$tempUninstallBackup = [System.IO.Path]::GetTempFileName() + ".reg"
$tempInstallDirBackup = [System.IO.Path]::GetTempFileName() + ".reg"

$hadUninstall = Test-Path $uninstallKey
$hadInstallDir = Test-Path $installDirKey

if ($hadUninstall) {
    Write-Host "[Registry Guard] Criando snapshot do registro de desinstalação..." -ForegroundColor Cyan
    & reg export "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\nexus" "$tempUninstallBackup" /y | Out-Null
}
if ($hadInstallDir) {
    Write-Host "[Registry Guard] Criando snapshot do registro de diretório de instalação..." -ForegroundColor Cyan
    & reg export "HKCU\Software\nexus" "$tempInstallDirBackup" /y | Out-Null
}

try {
    Write-Host "[Registry Guard] Executando teste em diretório isolado: $TargetDirectory" -ForegroundColor Yellow
    if (-not (Test-Path $TargetDirectory)) {
        New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
    }

    if ($InstallerPath -and (Test-Path $InstallerPath)) {
        Start-Process -FilePath $InstallerPath -ArgumentList "/S /D=$TargetDirectory" -Wait
    }
}
finally {
    Write-Host "[Registry Guard] Restaurando estado do registro do Windows..." -ForegroundColor Cyan
    
    # 1. Checa e limpa Uninstall
    $currentInstallLocation = (Get-ItemProperty -Path $uninstallKey -ErrorAction SilentlyContinue).InstallLocation
    if ($currentInstallLocation -and $currentInstallLocation.ToLower().Contains("test")) {
        Write-Host "  -> Detectado registro contaminado apontando para '$currentInstallLocation'. Limpando..." -ForegroundColor Red
        & reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\nexus" /f | Out-Null
        
        if ($hadUninstall -and (Test-Path $tempUninstallBackup)) {
            Write-Host "  -> Restaurando registro anterior legítimo de desinstalação..." -ForegroundColor Green
            & reg import "$tempUninstallBackup" | Out-Null
        }
    }

    # 2. Checa e limpa HKCU\Software\nexus
    $currentNexusDir = (Get-ItemProperty -Path "$installDirKey\nexus" -ErrorAction SilentlyContinue)."(default)"
    if ($currentNexusDir -and $currentNexusDir.ToLower().Contains("test")) {
        & reg delete "HKCU\Software\nexus" /f | Out-Null
        if ($hadInstallDir -and (Test-Path $tempInstallDirBackup)) {
            & reg import "$tempInstallDirBackup" | Out-Null
        }
    }

    if (Test-Path $tempUninstallBackup) {
        Remove-Item -Force $tempUninstallBackup -ErrorAction SilentlyContinue
    }
    if (Test-Path $tempInstallDirBackup) {
        Remove-Item -Force $tempInstallDirBackup -ErrorAction SilentlyContinue
    }
    Write-Host "[Registry Guard] Proteção concluída. Registro do Windows está limpo e seguro." -ForegroundColor Green
}
