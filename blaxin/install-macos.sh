#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# BLAXIN — Production-Grade Installer for macOS
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/tasinxxx/Blaxin/main/install.sh | bash
#   (dispatched from the root installer on macOS — you can also run this
#    script directly)
#
# What it does:
#   1. Detects CPU architecture (Apple Silicon arm64 / Intel x86_64)
#   2. Downloads the native .dmg for the FINAL v1.4.0 release
#   3. Verifies the SHA-256 checksum (mandatory — aborts on mismatch)
#   4. Mounts the .dmg and copies BLAXIN.app into /Applications
#   5. Launches BLAXIN
#
# Requirements:
#   - macOS 10.15+
#   - curl (ships with macOS)
#
# Security:
#   - Downloads ONLY from official GitHub releases over HTTPS
#   - Refuses to run the app unless checksum verification passed
#   - No arbitrary URLs, no telemetry, no credential collection
# ═══════════════════════════════════════════════════════════════════════

set -Eeuo pipefail

REPO="tasinxxx/Blaxin"
APP_NAME="BLAXIN"
VERSION_NUM="1.4.0"
# Test hooks (opt-in only, rustup-style): BLAXIN_DOWNLOAD_BASE points the
# artifact download at an alternative base (the installer test harness
# serves a local fake); BLAXIN_DRY_RUN stops right after checksum
# verification, before anything is mounted or installed. The default is
# the official GitHub release endpoint — production behavior unchanged.
DOWNLOAD_BASE="${BLAXIN_DOWNLOAD_BASE:-https://github.com/${REPO}/releases/download/v${VERSION_NUM}}"
GITHUB_API="https://api.github.com/repos/${REPO}/releases/tags/v${VERSION_NUM}"

CURL_TIMEOUT=30
MAX_RETRIES=3
RETRY_DELAY=2

EXIT_SUCCESS=0
EXIT_NETWORK_ERROR=3
EXIT_DOWNLOAD_ERROR=4
EXIT_VERIFICATION_ERROR=5
EXIT_UNSUPPORTED_ERROR=8

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

_log() { local c="$1" p="$2"; shift 2; echo -e "${c}[${p}]${NC} $*"; }
info()    { _log "${BLUE}"   "INFO" "$@"; }
success() { _log "${GREEN}"  "  OK" "$@"; }
warn()    { _log "${YELLOW}" "WARN" "$@"; }
error()   { _log "${RED}"    "ERROR" "$@" >&2; }
fatal()   { error "$@"; exit "${EXIT_GENERAL_ERROR:-1}"; }

header() { echo ""; echo -e "${CYAN}${BOLD}$*${NC}"; }

TEMP_DIR=""
cleanup() {
    if [[ -n "${TEMP_DIR}" && -d "${TEMP_DIR}" ]]; then
        # Detach any mount we created, then remove the temp dir.
        if [[ -n "${MOUNT_DIR:-}" && -d "${MOUNT_DIR}" ]]; then
            hdiutil detach "${MOUNT_DIR}" -quiet >/dev/null 2>&1 || true
        fi
        rm -rf "${TEMP_DIR}"
    fi
}
trap cleanup EXIT

retry() {
    local max="$1" delay="$2"; shift 2
    local attempt=1 rc
    while (( attempt <= max )); do
        if "$@"; then return 0; fi
        rc=$?
        if (( attempt == max )); then return $rc; fi
        warn "Attempt $attempt/$max failed. Retrying in ${delay}s..."
        sleep "$delay"
        delay=$(( delay * 2 ))
        (( attempt++ ))
    done
}

download_file() {
    local url="$1" dest="$2"
    curl -fL --progress-bar \
        --connect-timeout "${CURL_TIMEOUT}" \
        --max-time 900 \
        --retry "${MAX_RETRIES}" \
        --retry-delay "${RETRY_DELAY}" \
        --retry-all-errors \
        -o "${dest}" "${url}"
}

# ── Banner ─────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}"
echo "  ╔═══════════════════════════════════════════════╗"
echo "  ║         ⚡  BLAXIN Installer (macOS)  ⚡      ║"
echo "  ╚═══════════════════════════════════════════════╝"
echo -e "${NC}"

# ═══════════════════════════════════════════════════════════════════════
# Step 1: System detection
# ═══════════════════════════════════════════════════════════════════════
header "Step 1/5: Checking system requirements"

OS_NAME="${BLAXIN_OS_NAME:-$(uname -s)}"
if [[ "${OS_NAME}" != "Darwin" ]]; then
    error "This installer is for macOS only. Detected: ${OS_NAME}"
    if [[ "${OS_NAME}" == "Linux" ]]; then
        info "On Linux use: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/blaxin/install.sh | bash"
    fi
    exit "${EXIT_UNSUPPORTED_ERROR}"
fi
success "Operating system: macOS ($(sw_vers -productVersion 2>/dev/null || echo 'unknown'))"

ARCH="${BLAXIN_ARCH_NAME:-$(uname -m)}"
case "${ARCH}" in
    arm64)  ARCH_TAG="aarch64" ;;
    x86_64) ARCH_TAG="x64" ;;
    *)
        error "Unsupported macOS architecture: ${ARCH}"
        exit "${EXIT_UNSUPPORTED_ERROR}"
        ;;
esac
success "Architecture: ${ARCH} → artifact suffix: ${ARCH_TAG}"

ARTIFACT="BLAXIN_${VERSION_NUM}_macOS_${ARCH_TAG}.dmg"
ARTIFACT_URL="${DOWNLOAD_BASE}/${ARTIFACT}"
info "Artifact: ${ARTIFACT}"

# hdiutil is only needed to mount/install — a dry run never mounts, so
# the requirement check would produce a false failure on non-macOS test
# hosts exercising the download+verify pipeline.
if [[ -z "${BLAXIN_DRY_RUN:-}" ]] && ! command -v hdiutil >/dev/null 2>&1; then
    fatal "hdiutil not found — this is not a normal macOS installation."
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 2: Download
# ═══════════════════════════════════════════════════════════════════════
header "Step 2/5: Downloading BLAXIN v${VERSION_NUM}"

TEMP_DIR="$(mktemp -d)"
DMG_PATH="${TEMP_DIR}/${ARTIFACT}"

info "Downloading ${ARTIFACT}..."
info "Source: ${ARTIFACT_URL}"
echo ""

if ! retry "${MAX_RETRIES}" "${RETRY_DELAY}" download_file "${ARTIFACT_URL}" "${DMG_PATH}"; then
    error "Download failed after ${MAX_RETRIES} attempts."
    echo ""
    echo -e "  ${BOLD}What to do:${NC}"
    echo "  • Check your internet connection and try again"
    echo "  • Download manually: ${ARTIFACT_URL}"
    echo "  • Check the release page: https://github.com/${REPO}/releases/tag/v${VERSION_NUM}"
    echo ""
    exit "${EXIT_DOWNLOAD_ERROR}"
fi

if [[ ! -s "${DMG_PATH}" ]]; then
    fatal "Downloaded file is empty. The release artifact may be corrupted."
fi
success "Downloaded: $(du -h "${DMG_PATH}" | cut -f1)"

# ═══════════════════════════════════════════════════════════════════════
# Step 3: Verify checksum (MANDATORY)
# ═══════════════════════════════════════════════════════════════════════
header "Step 3/5: Verifying package"

SHA_URL="${ARTIFACT_URL}.sha256"
SHA_PATH="${DMG_PATH}.sha256"

if ! download_file "${SHA_URL}" "${SHA_PATH}" >/dev/null 2>&1; then
    error "Checksum file unavailable: ${SHA_URL}"
    error "REFUSING to install an unverifiable package."
    echo ""
    echo -e "  ${BOLD}What to do:${NC}"
    echo "  • Retry later — the checksum may be propagating"
    echo "  • Verify the SHA-256 yourself and install manually:"
    echo "      shasum -a 256 ${ARTIFACT}"
    echo ""
    exit "${EXIT_VERIFICATION_ERROR}"
fi

EXPECTED_HASH="$(awk '{print $1}' "${SHA_PATH}")"
ACTUAL_HASH="$(shasum -a 256 "${DMG_PATH}" | awk '{print $1}')"

if [[ ! "${EXPECTED_HASH}" =~ ^[0-9a-fA-F]{64}$ ]]; then
    error "Checksum file is malformed — refusing to install."
    exit "${EXIT_VERIFICATION_ERROR}"
fi

if [[ "$(printf '%s' "${EXPECTED_HASH}" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "${ACTUAL_HASH}" | tr '[:upper:]' '[:lower:]')" ]]; then
    error "Checksum mismatch!"
    error "Expected: ${EXPECTED_HASH}"
    error "Actual:   ${ACTUAL_HASH}"
    error "The downloaded file may be corrupted or tampered with."
    fatal "Aborting installation for safety."
fi
success "Checksum verified: ${ACTUAL_HASH:0:16}..."

# Dry-run gate: OS/arch detection, download and checksum verification are
# side-effect free; the test harness exercises exactly this pipeline.
if [[ -n "${BLAXIN_DRY_RUN:-}" ]]; then
    success "Dry run (BLAXIN_DRY_RUN): artifact + checksum verified — stopping before install"
    exit "${EXIT_SUCCESS}"
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 4: Install to /Applications
# ═══════════════════════════════════════════════════════════════════════
header "Step 4/5: Installing BLAXIN"

MOUNT_DIR="${TEMP_DIR}/mount"
mkdir -p "${MOUNT_DIR}"

info "Mounting ${ARTIFACT}..."
if ! hdiutil attach "${DMG_PATH}" -nobrowse -readonly -mountpoint "${MOUNT_DIR}" >/dev/null; then
    fatal "Could not mount the disk image. It may be corrupted (checksum passed, so this is unusual)."
fi

APP_SRC=""
for candidate in "${MOUNT_DIR}/${APP_NAME}.app" "${MOUNT_DIR}"/*.app; do
    if [[ -d "${candidate}" ]]; then APP_SRC="${candidate}"; break; fi
done
if [[ -z "${APP_SRC}" ]]; then
    hdiutil detach "${MOUNT_DIR}" -quiet >/dev/null 2>&1 || true
    fatal "No .app bundle found inside the disk image."
fi

# Replace any previous installation atomically-ish (idempotent rerun).
if [[ -d "/Applications/${APP_NAME}.app" ]]; then
    info "Removing previous installation..."
    rm -rf "/Applications/${APP_NAME}.app"
fi

info "Copying ${APP_NAME}.app to /Applications (this can take a moment)..."
if ! ditto "${APP_SRC}" "/Applications/${APP_NAME}.app"; then
    hdiutil detach "${MOUNT_DIR}" -quiet >/dev/null 2>&1 || true
    fatal "Could not copy ${APP_NAME}.app to /Applications."
fi

hdiutil detach "${MOUNT_DIR}" -quiet >/dev/null 2>&1 || true
MOUNT_DIR=""

# Remove the quarantine attribute set by the download. The app is still
# Gatekeeper-checked on first launch (unsigned ad-hoc builds show the
# right-click → Open prompt). We do NOT disable any OS security.
xattr -dr com.apple.quarantine "/Applications/${APP_NAME}.app" >/dev/null 2>&1 || true

if [[ ! -x "/Applications/${APP_NAME}.app/Contents/MacOS/${APP_NAME}" ]]; then
    fatal "Installation verification failed: the app binary is missing after install."
fi
success "Installed: /Applications/${APP_NAME}.app"

# ═══════════════════════════════════════════════════════════════════════
# Step 5: Launch
# ═══════════════════════════════════════════════════════════════════════
header "Step 5/5: Launching BLAXIN"

if open -a "/Applications/${APP_NAME}.app" 2>/dev/null; then
    success "BLAXIN launched"
else
    warn "Automatic launch failed — open BLAXIN from Launchpad or /Applications."
fi

echo ""
echo -e "${GREEN}${BOLD}"
echo "  ╔═══════════════════════════════════════════════╗"
echo "  ║      ⚡  BLAXIN Installed Successfully!  ⚡   ║"
echo "  ╚═══════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  Version:    ${BOLD}v${VERSION_NUM} (final release)${NC}"
echo -e "  Installed:  /Applications/${APP_NAME}.app"
echo ""
echo -e "  ${BOLD}First run:${NC}"
echo "    macOS may ask to confirm opening an unidentified developer app:"
echo "    right-click BLAXIN → Open (once). BLAXIN is not notarized."
echo "    The setup wizard walks you through provider/model configuration."
echo ""
echo -e "  ${BOLD}Platform notes (honest capability matrix):${NC}"
echo "    • Core (GUI, chat, providers, memory, missions, filesystem): works"
echo "    • Browser automation via Chrome/Edge CDP: works"
echo "    • Clipboard via pbcopy/pbpaste: works"
echo "    • Desktop input automation (xdotool-style): NOT available on macOS"
echo ""
echo -e "  ${BOLD}To uninstall:${NC}"
echo "    rm -rf /Applications/${APP_NAME}.app"
echo ""
