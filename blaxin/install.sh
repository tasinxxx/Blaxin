#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# BLAXIN — Production-Grade Installer for Linux
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/tasinxxx/Blaxin/main/blaxin/install.sh | bash
#
# What it does:
#   1. Detects Linux distribution and architecture
#   2. Resolves the latest stable BLAXIN release from GitHub
#   3. On Debian-family distros (Debian/Ubuntu/Kali/Mint/Pop!_OS) installs
#      the .deb package — it runs against the system WebKitGTK, which is the
#      most reliable configuration. Pass --appimage to force the portable
#      AppImage instead (the default on non-Debian distros).
#   4. Downloads the selected artifact with retry and timeout
#   5. Verifies SHA-256 checksum
#   6. Installs the package (requires sudo)
#   7. Verifies the installation
#
# Requirements:
#   - Linux x86_64
#   - curl or wget
#   - sudo privileges (for /opt installation)
#
# Security:
#   - Downloads ONLY from official GitHub releases
#   - Verifies SHA-256 checksums
#   - No arbitrary code execution from remote sources
#   - Shows exactly what will be installed before proceeding
# ═══════════════════════════════════════════════════════════════════════

set -Eeuo pipefail

# ── Configuration ──────────────────────────────────────────────────────
REPO="tasinxxx/Blaxin"
APP_NAME="blaxin"
INSTALL_DIR="/opt/blaxin"
BIN_DIR="/usr/local/bin"
DESKTOP_DIR="/usr/share/applications"
ICON_DIR="/usr/share/pixmaps"
# Test hooks (rustup-style, opt-in only): BLAXIN_GITHUB_API points the
# release lookup at an alternative endpoint (the installer test harness
# uses a local fake); BLAXIN_DRY_RUN stops right after checksum
# verification, before anything is installed. Defaults are the official
# GitHub endpoints — production behavior is unchanged.
GITHUB_API="${BLAXIN_GITHUB_API:-https://api.github.com/repos/${REPO}/releases/latest}"
GITHUB_DOWNLOAD="https://github.com/${REPO}/releases/download"

# Timeouts
CURL_TIMEOUT=30
MAX_RETRIES=3
RETRY_DELAY=2

# Exit codes
EXIT_SUCCESS=0
EXIT_GENERAL_ERROR=1
EXIT_INVALID_ARGUMENT=2
EXIT_NETWORK_ERROR=3
EXIT_DOWNLOAD_ERROR=4
EXIT_VERIFICATION_ERROR=5
EXIT_PERMISSION_ERROR=6
EXIT_SPACE_ERROR=7
EXIT_UNSUPPORTED_ERROR=8

# ── Colors ─────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── Logging ────────────────────────────────────────────────────────────
_log() {
    local color="$1" prefix="$2"
    shift 2
    echo -e "${color}[${prefix}]${NC} $*"
}

info()    { _log "${BLUE}"   "INFO"  "$@"; }
success() { _log "${GREEN}"  "  OK"  "$@"; }
warn()    { _log "${YELLOW}" "WARN"  "$@"; }
error()   { _log "${RED}"    "ERROR" "$@" >&2; }
fatal()   { error "$@"; exit "${EXIT_GENERAL_ERROR}"; }

usage() {
    cat <<'EOF'
Usage: install.sh [OPTIONS]

Installs the latest stable BLAXIN release for Linux x86_64.

Options:
  --appimage   Force the portable AppImage install. On Debian-family
               distros the .deb package is preferred by default because
               it uses the system WebKitGTK.
  -h, --help   Show this help and exit

Examples:
  curl -fsSL https://raw.githubusercontent.com/tasinxxx/Blaxin/main/blaxin/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/tasinxxx/Blaxin/main/blaxin/install.sh | bash -s -- --appimage
EOF
}

# ── Argument parsing ───────────────────────────────────────────────────
FORCE_APPIMAGE=false
for arg in "$@"; do
    case "${arg}" in
        --appimage) FORCE_APPIMAGE=true ;;
        -h|--help)  usage; exit "${EXIT_SUCCESS}" ;;
        *)          fatal "Unknown argument: ${arg}. Run with --help for usage." ;;
    esac
done

header() {
    echo ""
    echo -e "${CYAN}${BOLD}$*${NC}"
    echo -e "${DIM}$(printf '%.0s─' {1..50})${NC}"
}

# ── Cleanup ────────────────────────────────────────────────────────────
TEMP_DIR=""
cleanup() {
    if [[ -n "${TEMP_DIR}" && -d "${TEMP_DIR}" ]]; then
        rm -rf "${TEMP_DIR}"
    fi
}
trap cleanup EXIT

# ── Utility functions ──────────────────────────────────────────────────
check_command() {
    command -v "$1" >/dev/null 2>&1
}

# Retry a command with exponential backoff
retry() {
    local max_attempts="$1"
    local delay="$2"
    shift 2
    local attempt=1
    local exit_code

    while (( attempt <= max_attempts )); do
        if "$@"; then
            return 0
        fi
        exit_code=$?
        if (( attempt == max_attempts )); then
            return $exit_code
        fi
        warn "Attempt $attempt/$max_attempts failed. Retrying in ${delay}s..."
        sleep "$delay"
        delay=$(( delay * 2 ))
        (( attempt++ ))
    done
}

# ── JSON Parsing ───────────────────────────────────────────────────────
# Use jq if available, fall back to grep/sed
HAS_JQ=false
if check_command jq; then
    HAS_JQ=true
fi

# Parse a JSON field using jq or grep/sed
json_get() {
    local json="$1"
    local field="$2"

    if [[ "${HAS_JQ}" == "true" ]]; then
        echo "${json}" | jq -r "${field}" 2>/dev/null
    else
        # Fallback: grep/sed for simple fields
        echo "${json}" | grep -o "\"${field}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/"
    fi
}

# ── Banner ─────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}"
echo "  ╔═══════════════════════════════════════════════╗"
echo "  ║                                               ║"
echo "  ║         ⚡  BLAXIN Installer  ⚡              ║"
echo "  ║                                               ║"
echo "  ║    Personal AI Desktop Agent for Linux        ║"
echo "  ║                                               ║"
echo "  ╚═══════════════════════════════════════════════╝"
echo -e "${NC}"

# ═══════════════════════════════════════════════════════════════════════
# Step 1: System Detection & Prerequisites
# ═══════════════════════════════════════════════════════════════════════
header "Step 1/6: Checking system requirements"

# Detect OS
OS_NAME="${BLAXIN_OS_NAME:-$(uname -s)}"
if [[ "${OS_NAME}" != "Linux" ]]; then
    fatal "This installer is for Linux only. Detected: ${OS_NAME}" \
          "Visit https://github.com/${REPO} for other platforms."
fi
success "Operating system: Linux"

# Detect architecture
ARCH="${BLAXIN_ARCH_NAME:-$(uname -m)}"
case "${ARCH}" in
    x86_64|amd64)
        ARCH="x86_64"
        ARCH_ALT="amd64"
        ;;
    aarch64|arm64)
        fatal "ARM64 support is coming soon. Currently x86_64 only." \
              "You can build from source: https://github.com/${REPO}"
        ;;
    *)
        fatal "Unsupported architecture: ${ARCH}" \
              "BLAXIN currently supports x86_64 Linux only."
        ;;
esac
success "Architecture: ${ARCH}"

# Detect distribution family — Debian-family distros (Debian, Ubuntu,
# Kali, Mint, Pop!_OS, ...) install the .deb package so the app runs
# against the system WebKitGTK (the bundled AppImage WebKit stack can
# fail to initialize EGL on some hosts).
DEBIAN_FAMILY=false
if [[ -f /etc/debian_version ]] || { check_command dpkg && check_command apt-get; }; then
    DEBIAN_FAMILY=true
fi

INSTALL_METHOD="appimage"
if [[ "${DEBIAN_FAMILY}" == "true" ]]; then
    DISTRO_NAME=$(lsb_release -ds 2>/dev/null || (grep -m1 '^ID=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"') || echo "Debian-family")
    success "Distribution: ${DISTRO_NAME}"
    if [[ "${FORCE_APPIMAGE}" == "true" ]]; then
        info "AppImage install forced via --appimage"
    else
        INSTALL_METHOD="deb"
        info "Debian-family detected — preferring the .deb package (system WebKitGTK)"
    fi
else
    success "Distribution: non-Debian (AppImage install)"
fi

# Detect download tool
DOWNLOAD_TOOL=""
if check_command curl; then
    DOWNLOAD_TOOL="curl"
elif check_command wget; then
    DOWNLOAD_TOOL="wget"
else
    fatal "Neither curl nor wget is installed." \
          "Install one of them: sudo apt install curl"
fi
success "Download tool: ${DOWNLOAD_TOOL} $(command -v ${DOWNLOAD_TOOL})"

# Check for sha256sum — mandatory. An unverifiable binary must NEVER be
# installed (fail closed). sha256sum ships with coreutils on every normal
# Linux; shasum covers the exotic remainder.
if ! check_command sha256sum && ! check_command shasum; then
    fatal "Neither sha256sum nor shasum is available — refusing to install an unverifiable binary (checksum verification is mandatory)." \
          "Install coreutils (provides sha256sum) and retry."
fi
HAS_SHA256=true
success "Checksum tool: available"

# Check disk space (need at least 200MB in /opt)
if check_command df; then
    AVAILABLE_KB=$(df -k /opt 2>/dev/null | awk 'NR==2{print $4}' || echo "0")
    if (( AVAILABLE_KB > 0 && AVAILABLE_KB < 204800 )); then
        warn "Low disk space on /opt: $(( AVAILABLE_KB / 1024 ))MB available"
        warn "BLAXIN requires at least ~200MB for installation."
    fi
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 2: Resolve Latest Release
# ═══════════════════════════════════════════════════════════════════════
header "Step 2/6: Finding latest release"

fetch_release_info() {
    local api_url="$1"
    local response=""
    local http_code=""

    if [[ "${DOWNLOAD_TOOL}" == "curl" ]]; then
        http_code=$(curl -s -w "%{http_code}" -o /dev/null \
            --connect-timeout "${CURL_TIMEOUT}" \
            --max-time "${CURL_TIMEOUT}" \
            -H "Accept: application/vnd.github+json" \
            "${api_url}" 2>/dev/null) || true

        if [[ "${http_code}" == "200" ]]; then
            response=$(curl -sS \
                --connect-timeout "${CURL_TIMEOUT}" \
                --max-time "${CURL_TIMEOUT}" \
                -H "Accept: application/vnd.github+json" \
                "${api_url}" 2>/dev/null)
        fi
    else
        response=$(wget -q -O - \
            --timeout="${CURL_TIMEOUT}" \
            --header="Accept: application/vnd.github+json" \
            "${api_url}" 2>/dev/null) || true
        http_code="200"
    fi

    if [[ "${http_code}" != "200" ]]; then
        return 1
    fi

    if [[ -z "${response}" ]]; then
        return 1
    fi

    echo "${response}"
    return 0
}

# Try fetching the latest release
RELEASE_JSON=""
RELEASE_JSON=$(fetch_release_info "${GITHUB_API}") || true

# Handle case where /releases/latest returns 404 (no releases yet)
if [[ -z "${RELEASE_JSON}" ]]; then
    echo ""
    error "Unable to retrieve the latest stable release."
    echo ""
    echo -e "  ${BOLD}This could mean:${NC}"
    echo "  • BLAXIN has not published a release yet"
    echo "  • The GitHub repository is temporarily unavailable"
    echo "  • Your network connection is interrupted"
    echo ""
    echo -e "  ${BOLD}What to do:${NC}"
    echo "  • Check your internet connection and try again"
    echo "  • Visit https://github.com/${REPO}/releases manually"
    echo "  • Report issues at https://github.com/${REPO}/issues"
    echo ""
    exit "${EXIT_NETWORK_ERROR}"
fi

# Parse version using jq or grep
VERSION=""
if [[ "${HAS_JQ}" == "true" ]]; then
    VERSION=$(echo "${RELEASE_JSON}" | jq -r '.tag_name // empty' 2>/dev/null)
else
    VERSION=$(echo "${RELEASE_JSON}" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
fi

if [[ -z "${VERSION}" ]]; then
    fatal "Release metadata is malformed. Could not determine version." \
          "Please report this at https://github.com/${REPO}/issues"
fi

# Check if release is a draft (reject drafts)
IS_DRAFT=""
if [[ "${HAS_JQ}" == "true" ]]; then
    IS_DRAFT=$(echo "${RELEASE_JSON}" | jq -r '.draft // false' 2>/dev/null)
fi
if [[ "${IS_DRAFT}" == "true" ]]; then
    fatal "The latest release is a draft and cannot be installed." \
          "Visit https://github.com/${REPO}/releases for published releases."
fi

success "Latest version: ${VERSION}"

# Find the AppImage asset, explicitly rejecting source archives
find_appimage_asset() {
    if [[ "${HAS_JQ}" == "true" ]]; then
        echo "${RELEASE_JSON}" | jq -r '
            .assets[]? |
            select(.name | test("\\.AppImage$")) |
            select(.name | test("(source|\\.tar\\.gz|\\.zip|data\\.tar\\.gz|control\\.tar\\.gz)") | not) |
            .browser_download_url
        ' 2>/dev/null | head -1
    else
        echo "${RELEASE_JSON}" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*\.AppImage"' | head -1 | sed 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || echo ""
    fi
}

# Find the .deb asset, explicitly rejecting source archives
find_deb_asset() {
    if [[ "${HAS_JQ}" == "true" ]]; then
        echo "${RELEASE_JSON}" | jq -r '
            .assets[]? |
            select(.name | test("\\.deb$")) |
            select(.name | test("(source|\\.tar\\.gz|\\.zip)") | not) |
            .browser_download_url
        ' 2>/dev/null | head -1
    else
        echo "${RELEASE_JSON}" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*\.deb"' | head -1 | sed 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || echo ""
    fi
}

# Select the artifact for the chosen install method
ASSET_URL=""
ASSET_KIND=""
if [[ "${INSTALL_METHOD}" == "deb" ]]; then
    ASSET_URL=$(find_deb_asset)
    ASSET_KIND="deb"
    if [[ -z "${ASSET_URL}" ]]; then
        warn "No .deb asset in release ${VERSION}. Falling back to AppImage."
        INSTALL_METHOD="appimage"
    fi
fi
if [[ "${INSTALL_METHOD}" == "appimage" ]]; then
    ASSET_URL=$(find_appimage_asset)
    ASSET_KIND="appimage"
    if [[ -z "${ASSET_URL}" ]]; then
        fatal "No AppImage found in release ${VERSION}." \
              "The release may be missing Linux artifacts." \
              "Visit https://github.com/${REPO}/releases to check available assets."
    fi
fi

ASSET_NAME=$(basename "${ASSET_URL}")
success "Artifact: ${ASSET_NAME} (${ASSET_KIND})"

# ═══════════════════════════════════════════════════════════════════════
# Step 3: Download
# ═══════════════════════════════════════════════════════════════════════
header "Step 3/6: Downloading BLAXIN ${VERSION}"

TEMP_DIR=$(mktemp -d)
DOWNLOAD_PATH="${TEMP_DIR}/${ASSET_NAME}"

download_file() {
    local url="$1"
    local dest="$2"

    if [[ "${DOWNLOAD_TOOL}" == "curl" ]]; then
        curl -fL \
            --progress-bar \
            --connect-timeout "${CURL_TIMEOUT}" \
            --max-time 300 \
            --retry "${MAX_RETRIES}" \
            --retry-delay "${RETRY_DELAY}" \
            --retry-all-errors \
            -o "${dest}" \
            "${url}"
    else
        wget -q --show-progress \
            --timeout="${CURL_TIMEOUT}" \
            --tries="${MAX_RETRIES}" \
            -O "${dest}" \
            "${url}"
    fi
}

info "Downloading ${ASSET_NAME}..."
info "Source: ${ASSET_URL}"
echo ""

if ! retry "${MAX_RETRIES}" "${RETRY_DELAY}" download_file "${ASSET_URL}" "${DOWNLOAD_PATH}"; then
    rm -f "${DOWNLOAD_PATH}"
    fatal "Download failed after ${MAX_RETRIES} attempts." \
          "Check your network connection and try again."
fi

# Verify the download is not empty
if [[ ! -s "${DOWNLOAD_PATH}" ]]; then
    rm -f "${DOWNLOAD_PATH}"
    fatal "Downloaded file is empty. The release artifact may be corrupted."
fi

DOWNLOAD_SIZE=$(stat -c%s "${DOWNLOAD_PATH}" 2>/dev/null || stat -f%z "${DOWNLOAD_PATH}" 2>/dev/null || echo "0")
if (( DOWNLOAD_SIZE < 1000000 )); then
    warn "Downloaded file is unusually small ($(( DOWNLOAD_SIZE / 1024 ))KB)."
    warn "Expected a BLAXIN ${ASSET_KIND} artifact. The file may be corrupted."
fi

success "Downloaded: ${ASSET_NAME} ($(numfmt --to=iec-i --suffix=B "${DOWNLOAD_SIZE}" 2>/dev/null || echo "${DOWNLOAD_SIZE} bytes"))"

# ═══════════════════════════════════════════════════════════════════════
# Step 4: Verify Checksum
# ═══════════════════════════════════════════════════════════════════════
header "Step 4/6: Verifying checksum"

if [[ "${HAS_SHA256}" == "true" ]]; then
    CHECKSUM_URL="${ASSET_URL}.sha256"
    CHECKSUM_PATH="${TEMP_DIR}/${ASSET_NAME}.sha256"

    # Fail closed: no checksum file means NO installation. (Phase 1 rule.)
    if ! download_file "${CHECKSUM_URL}" "${CHECKSUM_PATH}" 2>/dev/null; then
        rm -f "${DOWNLOAD_PATH}"
        error "Checksum file unavailable: ${CHECKSUM_URL}"
        error "REFUSING to install an unverifiable package."
        echo ""
        echo -e "  ${BOLD}What to do:${NC}"
        echo "  • Retry later — the checksum may still be propagating"
        echo "  • Verify the SHA-256 yourself and install manually:"
        echo "      sha256sum ${ASSET_NAME}"
        echo ""
        exit "${EXIT_VERIFICATION_ERROR}"
    fi

    EXPECTED_HASH=$(awk '{print $1}' "${CHECKSUM_PATH}")

    if [[ ! "${EXPECTED_HASH}" =~ ^[0-9a-fA-F]{64}$ ]]; then
        rm -f "${DOWNLOAD_PATH}"
        error "Checksum file is malformed — refusing to install."
        exit "${EXIT_VERIFICATION_ERROR}"
    fi

    if check_command sha256sum; then
        ACTUAL_HASH=$(sha256sum "${DOWNLOAD_PATH}" | awk '{print $1}')
    else
        ACTUAL_HASH=$(shasum -a 256 "${DOWNLOAD_PATH}" | awk '{print $1}')
    fi

    if [[ "$(printf '%s' "${EXPECTED_HASH}" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "${ACTUAL_HASH}" | tr '[:upper:]' '[:lower:]')" ]]; then
        rm -f "${DOWNLOAD_PATH}"
        error "Checksum mismatch!"
        error "Expected: ${EXPECTED_HASH}"
        error "Actual:   ${ACTUAL_HASH}"
        error "The downloaded file may be corrupted or tampered with."
        fatal "Aborting installation for safety."
    fi

    success "Checksum verified: ${ACTUAL_HASH:0:16}..."
fi

# Dry-run gate: everything up to here (OS/arch detection, release lookup,
# download, checksum verification) is side-effect free. The test harness
# exercises exactly this pipeline; nothing is installed in dry-run mode.
if [[ -n "${BLAXIN_DRY_RUN:-}" ]]; then
    success "Dry run (BLAXIN_DRY_RUN): artifact + checksum verified — stopping before install"
    exit "${EXIT_SUCCESS}"
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 5: Install
# ═══════════════════════════════════════════════════════════════════════
header "Step 5/6: Installing BLAXIN"

# Determine if we need sudo
SUDO=""
if [[ "${EUID}" -ne 0 ]]; then
    if check_command sudo; then
        SUDO="sudo"
        info "Using sudo for system installation"
    else
        fatal "This installer requires root privileges to install to ${INSTALL_DIR}." \
              "Run with sudo or as root."
    fi
fi

if [[ "${INSTALL_METHOD}" == "deb" ]]; then
    # ── .deb install (Debian-family) ─────────────────────────────────
    info "Installing .deb package with dpkg..."
    if ! ${SUDO} dpkg -i "${DOWNLOAD_PATH}"; then
        warn "dpkg needs dependencies — running: apt-get install -f -y"
        ${SUDO} apt-get install -f -y || fatal "Could not resolve package dependencies with apt."
        if ! ${SUDO} dpkg -i "${DOWNLOAD_PATH}"; then
            ${SUDO} apt-get install -y "${DOWNLOAD_PATH}" || \
                fatal "Failed to install the .deb package (${ASSET_NAME})." \
                      "Try manually: sudo apt install ./${ASSET_NAME}"
        fi
    fi
    success "Installed package: ${APP_NAME} ${VERSION}"

    # Guard against a stale /usr/local/bin/blaxin (e.g. a previous
    # AppImage wrapper or third-party launcher) shadowing the packaged
    # /usr/bin/blaxin that desktop menu entries resolve to.
    if [[ -e "${BIN_DIR}/${APP_NAME}" ]]; then
        STALE_REAL=$(readlink -f "${BIN_DIR}/${APP_NAME}" 2>/dev/null || echo "")
        USR_BIN_REAL=$(readlink -f "/usr/bin/${APP_NAME}" 2>/dev/null || echo "")
        if [[ -n "${STALE_REAL}" && "${STALE_REAL}" != "${USR_BIN_REAL}" ]]; then
            BACKUP_NAME="${BIN_DIR}/${APP_NAME}.bak-stale"
            ${SUDO} mv "${BIN_DIR}/${APP_NAME}" "${BACKUP_NAME}"
            warn "Moved stale launcher ${BIN_DIR}/${APP_NAME} to ${BACKUP_NAME} so /usr/bin/${APP_NAME} is used."
        fi
    fi

    INSTALL_PATH="/usr/bin/${APP_NAME}"
else
    # ── AppImage install (non-Debian or forced) ──────────────────────
    # Create directories
    ${SUDO} mkdir -p "${INSTALL_DIR}"
    ${SUDO} mkdir -p "${BIN_DIR}"
    ${SUDO} mkdir -p "${DESKTOP_DIR}"
    ${SUDO} mkdir -p "${ICON_DIR}"

    # Remove old installation if exists (idempotent)
    if [[ -f "${INSTALL_DIR}/${ASSET_NAME}" ]]; then
        info "Removing previous installation..."
        # Find and remove old AppImages
        find "${INSTALL_DIR}" -name "*.AppImage" -exec ${SUDO} rm -f {} \; 2>/dev/null || true
        success "Cleaned previous installation"
    fi

    # Make AppImage executable
    chmod +x "${DOWNLOAD_PATH}"

    # Install AppImage
    INSTALL_PATH="${INSTALL_DIR}/${ASSET_NAME}"
    ${SUDO} cp "${DOWNLOAD_PATH}" "${INSTALL_PATH}"
    ${SUDO} chmod 755 "${INSTALL_PATH}"
    success "Installed AppImage to ${INSTALL_PATH}"

    # Create wrapper script in /usr/local/bin
    WRAPPER_CONTENT="#!/bin/bash
exec \"${INSTALL_PATH}\" \"\$@\"
"
    echo "${WRAPPER_CONTENT}" | ${SUDO} tee "${BIN_DIR}/${APP_NAME}" > /dev/null
    ${SUDO} chmod 755 "${BIN_DIR}/${APP_NAME}"
    success "Created launcher: ${BIN_DIR}/${APP_NAME}"

    # Create .desktop file
    DESKTOP_CONTENT="[Desktop Entry]
Type=Application
Name=BLAXIN
GenericName=AI Desktop Agent
Comment=Personal AI Desktop Agent — Control your computer with natural language
Exec=${INSTALL_PATH} %U
Icon=blaxin
Terminal=false
StartupNotify=true
Categories=Utility;Development;System;
Keywords=ai;agent;desktop;automation;assistant;
StartupWMClass=blaxin
MimeType=x-scheme-handler/blaxin;
"
    echo "${DESKTOP_CONTENT}" | ${SUDO} tee "${DESKTOP_DIR}/${APP_NAME}.desktop" > /dev/null
    ${SUDO} chmod 644 "${DESKTOP_DIR}/${APP_NAME}.desktop"
    success "Created desktop entry: ${DESKTOP_DIR}/${APP_NAME}.desktop"

    # Try to extract icon from AppImage
    info "Extracting application icon..."
    TMP_EXTRACT="${TEMP_DIR}/extract"
    mkdir -p "${TMP_EXTRACT}"

    if "${INSTALL_PATH}" --appimage-extract > /dev/null 2>&1; then
        # Look for icon in standard locations
        ICON_FOUND=false
        for icon_path in \
            "squashfs-root/usr/share/icons/hicolor/256x256/apps/blaxin.png" \
            "squashfs-root/usr/share/icons/hicolor/128x128/apps/blaxin.png" \
            "squashfs-root/usr/share/icons/hicolor/512x512/apps/blaxin.png" \
            "squashfs-root/AppRun.png" \
            "squashfs-root/*.png"; do
            # Use glob matching for the last pattern
            if [[ "${icon_path}" == *"*" ]]; then
                for f in ${icon_path}; do
                    if [[ -f "${f}" ]]; then
                        ${SUDO} cp "${f}" "${ICON_DIR}/blaxin.png"
                        success "Extracted icon from AppImage"
                        ICON_FOUND=true
                        break 2
                    fi
                done
            elif [[ -f "${icon_path}" ]]; then
                ${SUDO} cp "${icon_path}" "${ICON_DIR}/blaxin.png"
                success "Extracted icon from AppImage"
                ICON_FOUND=true
                break
            fi
        done

        rm -rf squashfs-root 2>/dev/null || true

        if [[ "${ICON_FOUND}" == "false" ]]; then
            warn "Could not extract icon from AppImage"
        fi
    else
        warn "Could not extract icon from AppImage (may require --appimage-extract support)"
    fi
fi

# Update desktop database and icon cache
if check_command update-desktop-database; then
    ${SUDO} update-desktop-database "${DESKTOP_DIR}" 2>/dev/null || true
    success "Updated desktop database"
fi

if check_command gtk-update-icon-cache; then
    ${SUDO} gtk-update-icon-cache -f "${ICON_DIR}" 2>/dev/null || true
    success "Updated icon cache"
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 6: Verify Installation
# ═══════════════════════════════════════════════════════════════════════
header "Step 6/6: Verifying installation"

INSTALLED=true

if [[ "${INSTALL_METHOD}" == "deb" ]]; then
    if dpkg -s "${APP_NAME}" > /dev/null 2>&1; then
        success "Package: ${APP_NAME} ${VERSION}"
    else
        error "Package ${APP_NAME} not found in dpkg database"
        INSTALLED=false
    fi
    if [[ -x "${INSTALL_PATH}" ]]; then
        success "Binary: ${INSTALL_PATH}"
    else
        error "Binary not found at ${INSTALL_PATH}"
        INSTALLED=false
    fi
else
    if [[ -f "${INSTALL_PATH}" ]]; then
        success "AppImage: ${INSTALL_PATH}"
    else
        error "AppImage not found at ${INSTALL_PATH}"
        INSTALLED=false
    fi

    if [[ -x "${BIN_DIR}/${APP_NAME}" ]]; then
        success "Launcher: ${BIN_DIR}/${APP_NAME}"
    else
        error "Launcher not found at ${BIN_DIR}/${APP_NAME}"
        INSTALLED=false
    fi

    if [[ -f "${DESKTOP_DIR}/${APP_NAME}.desktop" ]]; then
        success "Desktop entry: ${DESKTOP_DIR}/${APP_NAME}.desktop"
    else
        error "Desktop entry not found"
        INSTALLED=false
    fi
fi

# Clean up temp directory
TEMP_DIR=""

# ═══════════════════════════════════════════════════════════════════════
# Done
# ═══════════════════════════════════════════════════════════════════════
echo ""
if [[ "${INSTALLED}" == "true" ]]; then
    echo -e "${GREEN}${BOLD}"
    echo "  ╔═══════════════════════════════════════════════╗"
    echo "  ║                                               ║"
    echo "  ║      ⚡  BLAXIN Installed Successfully!  ⚡   ║"
    echo "  ║                                               ║"
    echo "  ╚═══════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo -e "  Version:    ${BOLD}${VERSION}${NC}"
    if [[ "${INSTALL_METHOD}" == "deb" ]]; then
        echo -e "  Package:    ${APP_NAME}_${VERSION}_amd64.deb (installed via dpkg/apt)"
        echo -e "  Binary:     ${INSTALL_PATH}"
        echo ""
        echo -e "  ${BOLD}To launch:${NC}"
        echo "    • Open ${CYAN}BLAXIN${NC} from your application menu"
        echo "    • Or run: ${CYAN}${APP_NAME}${NC}"
        echo ""
        echo -e "  ${BOLD}First run:${NC}"
        echo "    BLAXIN will guide you through setup on first launch."
        echo "    You'll configure your AI provider and select a model."
        echo ""
        echo -e "  ${BOLD}To uninstall:${NC}"
        echo "    sudo apt remove ${APP_NAME}"
    else
        echo -e "  Installed:  ${INSTALL_PATH}"
        echo -e "  Launcher:   ${BIN_DIR}/${APP_NAME}"
        echo ""
        echo -e "  ${BOLD}To launch:${NC}"
        echo "    • Open ${CYAN}BLAXIN${NC} from your application menu"
        echo "    • Or run: ${CYAN}${APP_NAME}${NC}"
        echo ""
        echo -e "  ${BOLD}First run:${NC}"
        echo "    BLAXIN will guide you through setup on first launch."
        echo "    You'll configure your AI provider and select a model."
        echo ""
        echo -e "  ${BOLD}To uninstall:${NC}"
        echo "    sudo rm -rf ${INSTALL_DIR} ${BIN_DIR}/${APP_NAME} ${DESKTOP_DIR}/${APP_NAME}.desktop ${ICON_DIR}/blaxin.png"
    fi
    echo ""
else
    echo ""
    error "Installation completed with errors."
    error "BLAXIN may not work correctly."
    error "Try reinstalling or check the error messages above."
    exit "${EXIT_GENERAL_ERROR}"
fi
