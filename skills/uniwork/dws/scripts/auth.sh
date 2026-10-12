#!/bin/sh
# Copyright 2026 Alibaba Group
# Licensed under the Apache License, Version 2.0
#
# DWS Authentication Script for Linux Servers/VMs (Headless Environment)
# Handles device flow authentication with proper logging and status checking.
#
# Usage:
#   sh auth.sh              # Start authentication flow
#   sh auth.sh --check      # Only check auth status (no login)
#   sh auth.sh --status     # Same as --check
#
# Environment variables:
#   DWS_AUTH_LOG_DIR  — Directory for auth logs (default: /sessions/$USER)
#   DWS_AUTH_TIMEOUT  — Max seconds to wait for auth link (default: 30)

set -eu

# ── Configuration ─────────────────────────────────────────────────────────────

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
AUTH_LOG_DIR="${DWS_AUTH_LOG_DIR:-/sessions/${USER:-$(whoami)}}"
AUTH_LOG_FILE="${AUTH_LOG_DIR}/dws_auth.log"
AUTH_TIMEOUT="${DWS_AUTH_TIMEOUT:-30}"

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

# Check if dws command is available
check_dws_installed() {
  if ! command -v dws >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

# Ensure log directory exists
ensure_log_dir() {
  if [ ! -d "${AUTH_LOG_DIR}" ]; then
    mkdir -p "${AUTH_LOG_DIR}" 2>/dev/null || {
      warn "Cannot create log directory: ${AUTH_LOG_DIR}"
      AUTH_LOG_DIR="/tmp"
      AUTH_LOG_FILE="${AUTH_LOG_DIR}/dws_auth_${USER:-$(whoami)}.log"
    }
  fi
}

# Get current auth status in JSON format
get_auth_status() {
  dws auth status --format json 2>/dev/null || echo '{"authenticated":false}'
}

# Check if currently authenticated
# Returns 0 if authenticated, 1 if not
is_authenticated() {
  status="$(get_auth_status)"

  # Use grep for more reliable pattern matching (POSIX compliant)
  # Check for explicit "authenticated": true
  if echo "$status" | grep -q '"authenticated"[[:space:]]*:[[:space:]]*true' 2>/dev/null; then
    return 0
  fi

  # Check for status: "authenticated"
  if echo "$status" | grep -q '"status"[[:space:]]*:[[:space:]]*"authenticated"' 2>/dev/null; then
    return 0
  fi

  # Default to not authenticated
  return 1
}

# Print auth status in human-readable format
print_auth_status() {
  status="$(get_auth_status)"
  printf '%s\n' "$status"
}

# ── Main Authentication Flow ───────────────────────────────────────────────────

do_auth() {
  # Step 1: Check dws installation
  if ! check_dws_installed; then
    err "dws is not installed or not in PATH. Please run install.sh first.\n   Install script: ${SCRIPT_DIR}/install.sh"
  fi

  say "✅ dws is installed: $(command -v dws)"

  # Step 2: Check current auth status
  say ""
  say "Checking authentication status..."

  auth_status="$(get_auth_status)"
  say "$auth_status"

  if is_authenticated; then
    say ""
    say "✅ Already authenticated!"
    exit 0
  fi

  say ""
  say "⚠️  Not authenticated. Starting device flow login..."

  # Step 3: Ensure log directory and clean up old log
  ensure_log_dir

  # Remove old log file if exists
  if [ -f "${AUTH_LOG_FILE}" ]; then
    rm -f "${AUTH_LOG_FILE}"
  fi

  # Step 4: Start device flow login in background
  say ""
  say "Starting device flow authentication..."
  say "Log file: ${AUTH_LOG_FILE}"
  say ""

  # Run dws auth login --device in background
  nohup dws auth login --device > "${AUTH_LOG_FILE}" 2>&1 &
  auth_pid=$!

  say "Authentication process started (PID: ${auth_pid})"
  say "Waiting for authorization link..."
  say ""

  # Step 5: Wait for auth link to appear in log
  waited=0

  while [ $waited -lt $AUTH_TIMEOUT ]; do
    sleep 1
    waited=$((waited + 1))

    if [ -f "${AUTH_LOG_FILE}" ]; then
      # Print current log content
      log_content="$(cat "${AUTH_LOG_FILE}" 2>/dev/null || true)"

      if [ -n "$log_content" ]; then
        # Check if we have authorization link or code
        if echo "$log_content" | grep -qE 'https://|dingtalk|授权码|code[：:]' 2>/dev/null; then
          break
        fi
      fi
    fi
  done

  # Step 6: Display auth information
  say "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  say "📱 AUTHORIZATION REQUIRED"
  say "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  say ""

  if [ -f "${AUTH_LOG_FILE}" ]; then
    # Print the full log content (contains the link and code)
    cat "${AUTH_LOG_FILE}"
    say ""
  fi

  say "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  say ""
  say "👆 Please open the authorization link above in your browser and complete"
  say "   the DingTalk scan/authorization."
  say ""
  say "⏳ The authentication process is running in the background (PID: ${auth_pid})."
  say ""
  say "After authorization, run one of the following to verify:"
  say "  sh ${SCRIPT_DIR}/auth.sh --check"
  say "  dws auth status --format json"
  say ""
  say "Log file: ${AUTH_LOG_FILE}"
}

# ── Check Only Mode ────────────────────────────────────────────────────────────

do_check() {
  if ! check_dws_installed; then
    err "dws is not installed or not in PATH."
  fi

  say "Current authentication status:"
  say ""

  auth_status="$(get_auth_status)"
  say "$auth_status"
  say ""

  if is_authenticated; then
    say "✅ Status: AUTHENTICATED"
    exit 0
  else
    say "❌ Status: NOT AUTHENTICATED"
    say ""
    say "Run the following to authenticate:"
    say "  sh ${SCRIPT_DIR}/auth.sh"
    exit 1
  fi
}

# ── Main Entry ─────────────────────────────────────────────────────────────────

main() {
  case "${1:-}" in
    --check|--status)
      do_check
      ;;
    --help|-h)
      say "Usage: sh auth.sh [OPTIONS]"
      say ""
      say "Options:"
      say "  --check, --status  Check auth status only (no login)"
      say "  --help, -h         Show help message"
      say ""
      say "Environment variables:"
      say "  DWS_AUTH_LOG_DIR   Directory for auth logs (default: /sessions/\$USER)"
      say "  DWS_AUTH_TIMEOUT   Max seconds to wait for auth link (default: 30)"
      ;;
    *)
      do_auth
      ;;
  esac
}

main "$@"
