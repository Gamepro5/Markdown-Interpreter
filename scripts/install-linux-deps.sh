#!/usr/bin/env bash
# Installs build dependencies for Markdown Interpreter on Linux.
# Supports: Debian/Ubuntu (apt), Fedora/RHEL (dnf), openSUSE (zypper),
#           Arch/Manjaro (pacman), Alpine (apk).
# Run with: bash scripts/install-linux-deps.sh

set -o pipefail

RED=$'\033[0;31m'
GRN=$'\033[0;32m'
YLW=$'\033[1;33m'
BLU=$'\033[0;34m'
RST=$'\033[0m'

log()  { printf '%s[INFO]%s  %s\n' "$BLU" "$RST" "$*"; }
ok()   { printf '%s[ OK ]%s  %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s[WARN]%s  %s\n' "$YLW" "$RST" "$*" >&2; }
err()  { printf '%s[FAIL]%s  %s\n' "$RED" "$RST" "$*" >&2; }

die() {
    err "$1"
    [ -n "${2:-}" ] && err "Hint: $2"
    exit 1
}

run() {
    log "exec: $*"
    if ! "$@"; then
        local rc=$?
        err "command failed (exit $rc): $*"
        return $rc
    fi
}

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "missing required command: $1" "${2:-install $1 first}"
}

detect_distro() {
    if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        DISTRO_ID="${ID:-unknown}"
        DISTRO_LIKE="${ID_LIKE:-}"
        DISTRO_NAME="${PRETTY_NAME:-$DISTRO_ID}"
    else
        DISTRO_ID="unknown"
        DISTRO_LIKE=""
        DISTRO_NAME="unknown"
    fi
    log "detected distro: $DISTRO_NAME (id=$DISTRO_ID, like=$DISTRO_LIKE)"
}

pick_pm() {
    case "$DISTRO_ID $DISTRO_LIKE" in
        *debian*|*ubuntu*|*mint*|*pop*) PM=apt ;;
        *fedora*|*rhel*|*centos*|*rocky*|*alma*) PM=dnf ;;
        *opensuse*|*suse*|*sles*) PM=zypper ;;
        *arch*|*manjaro*|*endeavouros*) PM=pacman ;;
        *alpine*) PM=apk ;;
        *)
            for c in apt dnf zypper pacman apk; do
                if command -v "$c" >/dev/null 2>&1; then
                    PM="$c"; break
                fi
            done
            ;;
    esac
    [ -n "${PM:-}" ] || die "could not detect a supported package manager" \
        "supported: apt, dnf, zypper, pacman, apk"
    log "using package manager: $PM"
}

sudo_cmd() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        require_cmd sudo "needed to install packages as a non-root user"
        sudo "$@"
    fi
}

install_packages() {
    case "$PM" in
        apt)
            run sudo_cmd apt-get update || die "apt-get update failed" \
                "check /etc/apt/sources.list and your network"
            run sudo_cmd apt-get install -y \
                build-essential curl wget file pkg-config \
                libwebkit2gtk-4.1-dev \
                libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
                libfuse2 \
                || die "apt-get install failed" \
                    "on Ubuntu 24.04+ use libfuse2t64 instead of libfuse2"
            ;;
        dnf)
            run sudo_cmd dnf install -y \
                @development-tools curl wget file \
                webkit2gtk4.1-devel \
                openssl-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel \
                rpm-build fuse-libs \
                || die "dnf install failed" "verify EPEL/RPM Fusion if needed"
            ;;
        zypper)
            run sudo_cmd zypper --non-interactive install -y \
                pattern:devel_basis curl wget file \
                webkit2gtk3-soup2-devel \
                libopenssl-devel gtk3-devel libappindicator3-devel librsvg-devel \
                rpm-build fuse \
                || die "zypper install failed"
            ;;
        pacman)
            run sudo_cmd pacman -Sy --needed --noconfirm \
                base-devel curl wget file \
                webkit2gtk-4.1 \
                openssl gtk3 libappindicator-gtk3 librsvg \
                fuse2 \
                || die "pacman install failed"
            ;;
        apk)
            run sudo_cmd apk add --no-cache \
                build-base curl wget file \
                webkit2gtk-dev \
                openssl-dev gtk+3.0-dev librsvg-dev \
                fuse \
                || die "apk install failed"
            ;;
    esac
    ok "system dependencies installed"
}

install_rust() {
    if command -v cargo >/dev/null 2>&1; then
        ok "rust already installed: $(rustc --version 2>&1)"
        return
    fi
    log "installing rust via rustup"
    require_cmd curl
    if ! curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable; then
        die "rustup install failed" "see https://rustup.rs for manual install"
    fi
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
    ok "rust installed: $(rustc --version)"
}

install_node() {
    if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
        ok "node already installed: $(node --version), npm $(npm --version)"
        return
    fi
    case "$PM" in
        apt)    run sudo_cmd apt-get install -y nodejs npm ;;
        dnf)    run sudo_cmd dnf install -y nodejs npm ;;
        zypper) run sudo_cmd zypper --non-interactive install -y nodejs npm ;;
        pacman) run sudo_cmd pacman -Sy --needed --noconfirm nodejs npm ;;
        apk)    run sudo_cmd apk add --no-cache nodejs npm ;;
    esac || die "node install failed" "consider installing via nvm (https://github.com/nvm-sh/nvm)"
    ok "node installed: $(node --version)"
}

install_tauri_cli() {
    if command -v cargo-tauri >/dev/null 2>&1 || cargo tauri --version >/dev/null 2>&1; then
        ok "tauri-cli already installed"
        return
    fi
    log "installing tauri-cli (this may take a few minutes)"
    if ! cargo install tauri-cli --locked; then
        die "cargo install tauri-cli failed" \
            "try: cargo install tauri-cli --version '^2.0' --locked"
    fi
    ok "tauri-cli installed"
}

install_npm_deps() {
    if [ ! -f package.json ]; then
        warn "no package.json in $(pwd) — skipping npm install"
        return
    fi
    log "installing npm dependencies"
    if ! npm install; then
        die "npm install failed" "delete node_modules/ and package-lock.json then retry"
    fi
    ok "npm dependencies installed"
}

main() {
    log "Markdown Interpreter — Linux dependency installer"
    [ "$(uname -s)" = "Linux" ] || die "this script is for Linux only (detected $(uname -s))"
    detect_distro
    pick_pm
    install_packages
    install_rust
    install_node
    install_tauri_cli
    install_npm_deps
    ok "all dependencies installed — run: npm run build"
}

main "$@"
