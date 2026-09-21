#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# BLAXIN — one-command installer (Linux + macOS)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/tasinxxx/Blaxin/main/install.sh | bash
#
# This dispatcher detects the OS and hands off to the platform installer:
#   Linux → blaxin/install.sh   (AppImage / .deb — the proven v1.4.0 flow)
#   macOS → blaxin/install-macos.sh (native .dmg → /Applications)
#
# Security: downloads ONLY from the official repository over HTTPS, and
# every platform installer verifies SHA-256 checksums before installing.
# ═══════════════════════════════════════════════════════════════════════

set -u

REPO="tasinxxx/Blaxin"
RAW_BASE="${BLAXIN_RAW_BASE:-https://raw.githubusercontent.com/${REPO}/main}"
# BLAXIN_OS_NAME/BLAXIN_ARCH_NAME are test hooks (default: real uname).
OS_NAME="${BLAXIN_OS_NAME:-$(uname -s)}"
ARCH_NAME="${BLAXIN_ARCH_NAME:-$(uname -m)}"

err()  { printf '[ERROR] %s\n' "$1" >&2; }
info() { printf '[INFO] %s\n' "$1";
}

# Optional passthrough args (e.g. --appimage for the Linux installer)
PASSTHROUGH=""
for arg in "$@"; do
    case "${arg}" in
        -h|--help)
            cat <<EOF
BLAXIN installer (Linux + macOS)

  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash

Options are passed through to the platform installer:
  --appimage   Linux: force the portable AppImage install
EOF
            exit 0
            ;;
        *) PASSTHROUGH="${PASSTHROUGH} ${arg}" ;;
    esac
done

case "${OS_NAME}" in
    Linux)
        info "Detected operating system: Linux (${ARCH_NAME})"
        info "Fetching the BLAXIN Linux installer from ${RAW_BASE}/blaxin/install.sh"
        if command -v curl >/dev/null 2>&1; then
            # shellcheck disable=SC2086
            curl -fsSL "${RAW_BASE}/blaxin/install.sh" | bash -s -- ${PASSTHROUGH}
            exit $?
        elif command -v wget >/dev/null 2>&1; then
            # shellcheck disable=SC2086
            wget -qO- "${RAW_BASE}/blaxin/install.sh" | bash -s -- ${PASSTHROUGH}
            exit $?
        else
            err "Neither curl nor wget is available. Install one and retry."
            exit 1
        fi
        ;;
    Darwin)
        info "Detected operating system: macOS (${ARCH_NAME})"
        info "Fetching the BLAXIN macOS installer from ${RAW_BASE}/blaxin/install-macos.sh"
        if command -v curl >/dev/null 2>&1; then
            # shellcheck disable=SC2086
            curl -fsSL "${RAW_BASE}/blaxin/install-macos.sh" | bash -s -- ${PASSTHROUGH}
            exit $?
        else
            err "curl is required on macOS (it ships with the OS)."
            exit 1
        fi
        ;;
    CYGWIN*|MINGW*|MSYS*)
        err "This shell installer does not run on Windows."
        err "Use PowerShell instead:"
        err "  irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex"
        exit 1
        ;;
    *)
        err "Unsupported operating system: ${OS_NAME}"
        err "BLAXIN v1.4.0 supports Linux, macOS and Windows:"
        err "  Linux/macOS : curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash"
        err "  Windows     : irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex"
        exit 1
        ;;
esac
