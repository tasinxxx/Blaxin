# ═══════════════════════════════════════════════════════════════════════
# BLAXIN — Production-Grade Installer for Windows
#
# Usage:
#   irm https://raw.githubusercontent.com/tasinxxx/Blaxin/main/install.ps1 | iex
#
# What it does:
#   1. Detects CPU architecture (x64; ARM64 reports honestly unsupported)
#   2. Downloads the native NSIS installer for the FINAL v1.4.0 release
#   3. Verifies the SHA-256 checksum (mandatory — aborts on mismatch)
#   4. Runs the installer silently (per-user, no admin required)
#   5. Launches BLAXIN
#
# Security:
#   - Downloads ONLY from official GitHub releases over HTTPS
#   - Refuses to run the installer unless checksum verification passed
#   - No arbitrary URLs, no telemetry, no credential collection
# ═══════════════════════════════════════════════════════════════════════

$ErrorActionPreference = 'Stop'

$Repo        = 'tasinxxx/Blaxin'
$VersionNum  = '1.4.0'
$DownloadBase = "https://github.com/$Repo/releases/download/v$VersionNum"
$ReleasePage  = "https://github.com/$Repo/releases/tag/v$VersionNum"

function Write-Step($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    WARN $msg" -ForegroundColor Yellow }
function Die($msg) {
    Write-Host "`n[ERROR] $msg" -ForegroundColor Red
    exit 1
}

# ── Banner ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '  ╔═══════════════════════════════════════════════╗' -ForegroundColor Cyan
Write-Host '  ║         ⚡  BLAXIN Installer (Windows)  ⚡    ║' -ForegroundColor Cyan
Write-Host '  ╚═══════════════════════════════════════════════╝' -ForegroundColor Cyan
Write-Host ''

# ═══════════════════════════════════════════════════════════════════════
# Step 1: System detection
# ═══════════════════════════════════════════════════════════════════════
Write-Step 'Step 1/5: Checking system requirements'

# PS 5.1 compat: TLS 1.2 + no IE engine dependency.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq 'ARM64') {
    Die ("BLAXIN v1.4.0 has no Windows ARM64 build yet (x64 only). Check for updates at $ReleasePage")
}
if ($arch -ne 'AMD64') {
    Die "Unsupported Windows architecture: $arch (BLAXIN supports x64)"
}
Write-Ok "Operating system: Windows ($([Environment]::OSVersion.VersionString)), x64"
Write-Ok "PowerShell $($PSVersionTable.PSVersion)"

$asset = "BLAXIN_${VersionNum}_Windows_x64-setup.exe"
$assetUrl = "$DownloadBase/$asset"
Write-Ok "Artifact: $asset"

# ═══════════════════════════════════════════════════════════════════════
# Step 2: Download
# ═══════════════════════════════════════════════════════════════════════
Write-Step 'Step 2/5: Downloading BLAXIN v1.4.0'

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("blaxin-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir | Out-Null
$exePath = Join-Path $tempDir $asset

try {
    Write-Host "    Source: $assetUrl"
    Invoke-WebRequest -Uri $assetUrl -OutFile $exePath -UseBasicParsing
    if (-not (Test-Path $exePath) -or (Get-Item $exePath).Length -eq 0) {
        Die 'Downloaded file is empty. The release artifact may be corrupted.'
    }
    Write-Ok ("Downloaded: {0:N1} MB" -f ((Get-Item $exePath).Length / 1MB))
} catch {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    Die (@(
        "Download failed: $($_.Exception.Message)",
        "What to do:",
        "  • Check your internet connection and try again",
        "  • Download manually: $assetUrl",
        "  • Release page: $ReleasePage"
    ) -join "`n")
}

# ═══════════════════════════════════════════════════════════════════════
# Step 3: Verify checksum (MANDATORY)
# ═══════════════════════════════════════════════════════════════════════
Write-Step 'Step 3/5: Verifying package'

$shaPath = "$exePath.sha256"
try {
    Invoke-WebRequest -Uri "$assetUrl.sha256" -OutFile $shaPath -UseBasicParsing
} catch {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    Die (@(
        'Checksum file unavailable — REFUSING to install an unverifiable package.',
        "What to do: retry later, or verify SHA-256 yourself and run $asset manually."
    ) -join "`n")
}

$expectedHash = (Get-Content $shaPath -TotalCount 1).Trim().Split(' ')[0].ToLowerInvariant()
$actualHash   = (Get-FileHash -Algorithm SHA256 $exePath).Hash.ToLowerInvariant()

if ($expectedHash -notmatch '^[0-9a-f]{64}$') {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    Die 'Checksum file is malformed — refusing to install.'
}
if ($expectedHash -ne $actualHash) {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    Die (@(
        "Checksum mismatch! Expected: $expectedHash",
        "                     Actual:   $actualHash",
        'The downloaded file may be corrupted or tampered with — aborting.'
    ) -join "`n")
}
Write-Ok "Checksum verified: $($actualHash.Substring(0, 16))..."

# ═══════════════════════════════════════════════════════════════════════
# Step 4: Install (silent, per-user)
# ═══════════════════════════════════════════════════════════════════════
Write-Step 'Step 4/5: Installing BLAXIN'

try {
    # /S = NSIS silent install (per-user mode: no admin prompt required).
    # /D= must be the LAST argument and unquoted; we keep the default dir.
    $proc = Start-Process -FilePath $exePath -ArgumentList '/S' -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
        Die "Installer exited with code $($proc.ExitCode). Nothing was verified as installed."
    }
} catch {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    Die "Installer failed to run: $($_.Exception.Message)"
}

# Verify the install actually landed (never assume).
$installCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\BLAXIN\BLAXIN.exe'),
    (Join-Path $env:LOCALAPPDATA 'BLAXIN\BLAXIN.exe'),
    (Join-Path $env:ProgramFiles 'BLAXIN\BLAXIN.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'BLAXIN\BLAXIN.exe')
)
$installedExe = $installCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $installedExe) {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    Die (@(
        'Installation verification failed: BLAXIN.exe was not found after the installer ran.',
        "Check the release page for help: $ReleasePage"
    ) -join "`n")
}
Write-Ok "Installed: $installedExe"

Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue

# ═══════════════════════════════════════════════════════════════════════
# Step 5: Launch
# ═══════════════════════════════════════════════════════════════════════
Write-Step 'Step 5/5: Launching BLAXIN'

try {
    Start-Process -FilePath $installedExe | Out-Null
    Write-Ok 'BLAXIN launched'
} catch {
    Write-Warn2 "Automatic launch failed: $($_.Exception.Message)"
    Write-Warn2 'Start BLAXIN from the Start Menu.'
}

Write-Host ''
Write-Host '  ╔═══════════════════════════════════════════════╗' -ForegroundColor Green
Write-Host '  ║      ⚡  BLAXIN Installed Successfully!  ⚡   ║' -ForegroundColor Green
Write-Host '  ╚═══════════════════════════════════════════════╝' -ForegroundColor Green
Write-Host ''
Write-Host "  Version:    v$VersionNum (final release)"
Write-Host "  Installed:  $installedExe"
Write-Host ''
Write-Host '  Platform notes (honest capability matrix):'
Write-Host '    • Core (GUI, chat, providers, memory, missions, filesystem): works'
Write-Host '    • Browser automation via Chrome/Edge CDP: works'
Write-Host '    • Clipboard via PowerShell: works'
Write-Host '    • Process control / desktop input automation (xdotool-style):'
Write-Host '      NOT available on Windows — reported honestly by the agent'
Write-Host ''
Write-Host '  To uninstall: Windows Settings → Apps → BLAXIN → Uninstall'
Write-Host ''
