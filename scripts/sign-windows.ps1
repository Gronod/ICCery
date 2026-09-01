<#
.SYNOPSIS
  Signs Windows executables and installer packages with Authenticode and RFC 3161 timestamps.

.DESCRIPTION
  Used by Tauri bundle.windows.signCommand during Windows packaging.
  Resolves certificate from WINDOWS_CODESIGN_CERT_PATH or %TEMP%\codesign.pfx.
  Gracefully skips if no certificate or credentials are present.
#>

param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$TargetFile
)

$ErrorActionPreference = "Stop"

if (!(Test-Path $TargetFile)) {
    Write-Warning "Target file does not exist: $TargetFile"
    exit 1
}

# Resolve certificate path
$certPath = $env:WINDOWS_CODESIGN_CERT_PATH
if ([string]::IsNullOrWhiteSpace($certPath) -or !(Test-Path $certPath)) {
    $tempCert = Join-Path $env:TEMP "codesign.pfx"
    if (Test-Path $tempCert) {
        $certPath = $tempCert
    } elseif ((Test-Path "C:\Users\gordon\codesign.pfx") -and !([string]::IsNullOrWhiteSpace($env:WINDOWS_CODESIGN_PASSWORD))) {
        $certPath = "C:\Users\gordon\codesign.pfx"
    }
}

if ([string]::IsNullOrWhiteSpace($certPath) -or !(Test-Path $certPath)) {
    Write-Host "Notice: No code signing certificate or credentials configured. Skipping signing for: $TargetFile"
    exit 0
}

Write-Host "==> Code signing target: $TargetFile"
Write-Host "    Using certificate: $certPath"

# Find signtool.exe
$signtool = $null
$cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
if ($cmd) {
    $signtool = $cmd.Source
} else {
    $sdkPaths = @(
        "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe",
        "C:\Program Files\Windows Kits\10\bin\*\x64\signtool.exe",
        "C:\Program Files (x86)\Windows Kits\10\App Certification Kit\signtool.exe"
    )
    foreach ($pattern in $sdkPaths) {
        $found = Get-Item -Path $pattern -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
        if ($found) {
            $signtool = $found.FullName
            break
        }
    }
}

if (!$signtool -or !(Test-Path $signtool)) {
    Write-Error "signtool.exe could not be found in PATH or Windows Kits directory."
    exit 1
}

Write-Host "    Using Signtool: $signtool"

$timestampServers = @(
    "http://timestamp.digicert.com",
    "http://timestamp.sectigo.com",
    "http://tsa.starfieldtech.com"
)

$signed = $false
$lastError = $null

foreach ($tsUrl in $timestampServers) {
    Write-Host "    Attempting signature with timestamp server: $tsUrl"

    $argsList = @("sign", "/fd", "SHA256", "/d", "ICCery", "/f", $certPath)
    if (![string]::IsNullOrWhiteSpace($env:WINDOWS_CODESIGN_PASSWORD)) {
        $argsList += @("/p", $env:WINDOWS_CODESIGN_PASSWORD)
    }
    $argsList += @("/tr", $tsUrl, "/td", "SHA256", $TargetFile)

    $proc = Start-Process -FilePath $signtool -ArgumentList $argsList -NoNewWindow -Wait -PassThru
    if ($proc.ExitCode -eq 0) {
        $signed = $true
        Write-Host "==> Successfully signed $TargetFile"
        break
    } else {
        $lastError = "Signtool exited with code $($proc.ExitCode) using $tsUrl"
        Write-Warning "    Failed with $tsUrl (Exit code: $($proc.ExitCode)). Retrying with next server..."
        Start-Sleep -Seconds 2
    }
}

if (!$signed) {
    Write-Error "Code signing failed for $TargetFile. Last error: $lastError"
    exit 1
}

# Verify signature
$sigCheck = Get-AuthenticodeSignature -FilePath $TargetFile
Write-Host "==> Signature Status: $($sigCheck.Status)"
if ($sigCheck.Status -ne "Valid") {
    Write-Warning "Authenticode status is '$($sigCheck.Status)' (Note: Self-signed / private root CA may report UnknownError or NotTrusted on machines without root installed)."
}
