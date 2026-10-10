#!/bin/sh
# =============================================================================
# Hermes backend service launcher for the CubeSandbox hermes template.
# =============================================================================
# CubeSandbox base image's cube-entrypoint.sh already starts envd on :49983
# in the background and execs this script as the foreground process.
#
# This script starts the Hermes backend (the dashboard / JSON-RPC+WS gateway)
# on :8000 — the port CubeSandbox exposes externally and probes for readiness.
#
# Auth gate: binding 0.0.0.0 engages the dashboard auth gate (June 2026
# hardening made --insecure a no-op). The bundled basic-auth provider
# (plugins/dashboard_auth/basic) satisfies it zero-infrastructure when
# HERMES_DASHBOARD_BASIC_AUTH_USERNAME + _PASSWORD are set. Both are baked
# into the image below (default admin/hermes) and overridable at runtime.
# =============================================================================
set -eu

# ── Hermes data directory (HERMES_HOME) ─────────────────────────────────
# /opt/data is the durable, S3-mountable hermes user-data volume. It holds
# config.yaml, .env, auth.json, sessions, cron, logs, skills, memories, …
# The cube writable layer is ephemeral, so ALL state that must survive a
# sandbox destroy/recreate lives here and is bind-mounted (or S3-mounted) in.
HERMES_HOME="${HERMES_HOME:-/opt/data}"
export HERMES_HOME

mkdir -p "$HERMES_HOME"

# ── Auth provider env (basic auth, zero-infra) ──────────────────────────
# Defaults are baked into the Dockerfile; allow runtime override so a fleet
# operator can rotate creds without rebuilding the image.
: "${HERMES_DASHBOARD_BASIC_AUTH_USERNAME:=admin}"
: "${HERMES_DASHBOARD_BASIC_AUTH_PASSWORD:=hermes}"
export HERMES_DASHBOARD_BASIC_AUTH_USERNAME \
       HERMES_DASHBOARD_BASIC_AUTH_PASSWORD

# ── Activate the hermes venv (Python 3.13, uv-managed) ──────────────────
# The venv was built against cube-base's glibc 2.35, so it runs natively
# inside the sandbox — no glibc forward-incompatibility.
# shellcheck disable=SC1091
. /opt/hermes/.venv/bin/activate

# ── Seed a minimal config.yaml on first boot if absent ──────────────────
# The dashboard reads config.yaml from $HERMES_HOME. When the data volume is
# fresh (first sandbox create), seed an empty config so the server doesn't
# choke on a missing file. Operators can later edit it via the dashboard.
if [ ! -f "$HERMES_HOME/config.yaml" ]; then
    cat > "$HERMES_HOME/config.yaml" << 'CFG_EOF'
# Hermes configuration — seeded by the cube-hermes sandbox template.
# Edit via the dashboard (http://<sandbox>:8000) or directly here.
CFG_EOF
fi

# ── Start the Hermes dashboard (frontend + backend gateway) on :8000 ────
# `hermes dashboard` boots the FastAPI + SPA server (web_server.start_server)
# which is the JSON-RPC/WebSocket gateway. --host 0.0.0.0 binds all
# interfaces (cube reaches it). --port 8000 matches the cube expose/probe.
# --no-open suppresses the browser-open (no display in headless sandbox).
export HOME="$HERMES_HOME"

cd "$HERMES_HOME"

exec hermes dashboard \
    --host 0.0.0.0 \
    --port 8000 \
    --no-open
