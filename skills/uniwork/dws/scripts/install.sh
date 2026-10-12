#!/bin/sh
# Copyright 2026 Alibaba Group
# Licensed under the Apache License, Version 2.0
#
# DWS Local Installer - Install from bundled tar.gz archives.
# No network access required, all binaries are included locally.
#
# Usage:
#   sh install.sh              # Auto-detect architecture and install
#   sh install.sh --arch amd64 # Force specific architecture
#   sh install.sh --help       # Show help
#
# Environment variables:
#   DWS_INSTALL_DIR  — where to put the binary (default: ~/.local/bin)

set -eu

# ── Configuration ─────────────────────────────────────────────────────────────

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BIN_NAME="dws"
INSTALL_DIR="${DWS_INSTALL_DIR:-$HOME/.local/bin}"
FORCE_ARCH="${FORCE_ARCH:-}"

# ── Helpers ────────────────────────────────────────────────────────────────────

say() {
  printf '  %s\n' "$@"
}

err() {
  printf '  ❌ %s\n' "$@" >&2
  exit 1
}

warn() {
  printf '  ⚠️  %s\n' "$@" >&2
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

# ── Banner ───────────────────────────────────────────────────────────────────

print_banner() {
  printf '\n'
  say "┌──────────────────────────────────────┐"
  say "│     DWS Local Installer              │"
  say "│     DingTalk Workspace CLI           │"
  say "└──────────────────────────────────────┘"
  printf '\n'
}

# ── Architecture Detection ────────────────────────────────────────────────────

detect_arch() {
  if [ -n "$FORCE_ARCH" ]; then
    echo "$FORCE_ARCH"
    return
  fi

  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64)
      echo "amd64"
      ;;
    arm64|aarch64)
      echo "arm64"
      ;;
    *)
      err "Unsupported architecture: $arch. Supported: amd64, arm64"
      ;;
  esac
}

detect_os() {
  os="$(uname -s)"
  case "$os" in
    Linux*)
      echo "linux"
      ;;
    Darwin*)
      echo "darwin"
      ;;
    *)
      err "Unsupported OS: $os. This installer supports Linux and macOS."
      ;;
  esac
}

# ── Installation ──────────────────────────────────────────────────────────────

install_binary() {
  os="$(detect_os)"
  arch="$(detect_arch)"

  archive_name="${BIN_NAME}-${os}-${arch}.tar.gz"
  archive_path="${SCRIPT_DIR}/${archive_name}"

  say "OS:      ${os}"
  say "Arch:    ${arch}"
  say "Archive: ${archive_name}"
  say ""

  # Check if archive exists
  if [ ! -f "$archive_path" ]; then
    err "Archive not found: ${archive_path}\n   Available archives in ${SCRIPT_DIR}:\n$(ls -1 "${SCRIPT_DIR}"/*.tar.gz 2>/dev/null || echo "   (none)")"
  fi

  say "📦 Extracting from local archive..."

  # Create temp directory
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT INT TERM

  # Extract archive
  if ! tar xzf "$archive_path" -C "$tmpdir" 2>/dev/null; then
    err "Failed to extract archive: ${archive_path}"
  fi

  # Find the binary
  found_bin=""
  if [ -f "$tmpdir/$BIN_NAME" ]; then
    found_bin="$tmpdir/$BIN_NAME"
  elif [ -f "$tmpdir/${BIN_NAME}-${os}-${arch}/$BIN_NAME" ]; then
    found_bin="$tmpdir/${BIN_NAME}-${os}-${arch}/$BIN_NAME"
  else
    found_bin="$(find "$tmpdir" -name "$BIN_NAME" -type f 2>/dev/null | head -1)"
  fi

  if [ -z "$found_bin" ] || [ ! -f "$found_bin" ]; then
    err "Could not find ${BIN_NAME} binary in the archive"
  fi

  # Create install directory
  mkdir -p "$INSTALL_DIR"

  # Copy binary
  cp "$found_bin" "$INSTALL_DIR/$BIN_NAME"
  chmod +x "$INSTALL_DIR/$BIN_NAME"

  say "✅ Binary installed: ${INSTALL_DIR}/${BIN_NAME}"
}

check_path() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

print_next_steps() {
  say ""
  say "🎉 Installation complete!"
  say ""

  if ! check_path; then
    say "⚠️  ${INSTALL_DIR} is not in your PATH."
    say ""
    say "Add it with:"
    say "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    say ""
    say "Or add this line to your ~/.bashrc or ~/.zshrc:"
    say "  echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.bashrc"
    say ""
  fi

  say "Next steps:"
  say "  dws version              # verify installation"
  say "  dws auth login --device  # authenticate with DingTalk (headless)"
  say "  dws --help               # explore commands"
  say ""
  say "For authentication on Linux servers, use:"
  say "  sh ${SCRIPT_DIR}/auth.sh"
}

# ── Main ─────────────────────────────────────────────────────────────────────

show_help() {
  say "DWS Local Installer - Install from bundled tar.gz archives"
  say ""
  say "Usage:"
  say "  sh install.sh              # Auto-detect architecture and install"
  say "  sh install.sh --arch ARCH  # Force specific architecture (amd64/arm64)"
  say "  sh install.sh --help       # Show this help"
  say ""
  say "Environment variables:"
  say "  DWS_INSTALL_DIR  — Installation directory (default: ~/.local/bin)"
  say ""
  say "Supported architectures:"
  say "  amd64  — x86_64 / x64"
  say "  arm64  — aarch64 / ARM64"
  say ""
  say "Available local archives:"
  for f in "${SCRIPT_DIR}"/*.tar.gz; do
    if [ -f "$f" ]; then
      say "  $(basename "$f")"
    fi
  done
}

main() {
  case "${1:-}" in
    --help|-h)
      print_banner
      show_help
      exit 0
      ;;
    --arch|-a)
      if [ -z "${2:-}" ]; then
        err "--arch requires an argument (amd64 or arm64)"
      fi
      case "$2" in
        amd64|arm64)
          FORCE_ARCH="$2"
          ;;
        *)
          err "Invalid architecture: $2. Supported: amd64, arm64"
          ;;
      esac
      shift 2
      ;;
  esac

  print_banner

  # Check if already installed
  if command -v dws >/dev/null 2>&1; then
    current_version="$(dws version 2>/dev/null || echo "unknown")"
    say "⚠️  dws is already installed: $(command -v dws)"
    say "   Current version: ${current_version}"
    say ""
    say "Reinstalling to: ${INSTALL_DIR}"
    say ""
  fi

  install_binary
  print_next_steps
}

main "$@"
