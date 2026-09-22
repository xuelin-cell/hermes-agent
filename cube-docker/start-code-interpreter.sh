#!/bin/sh
# Start the lightweight code interpreter service.
# =============================================================================
# CubeSandbox base image's cube-entrypoint.sh already starts envd on :49983
# in the background and execs this script as the foreground process.
#
# This script starts:
#   1. Jupyter Server on 127.0.0.1:8888 (internal, no token) — provides the
#      IPython kernel via /api/kernels WebSocket.
#   2. Uvicorn serving the FastAPI app on :49999 (exposed) — provides
#      /execute, /health, /contexts. This is the Cube code-interpreter API.
# =============================================================================
set -eu

CODE_INTERPRETER_HOST="${CODE_INTERPRETER_HOST:-0.0.0.0}"
CODE_INTERPRETER_PORT="${CODE_INTERPRETER_PORT:-49999}"
CODE_INTERPRETER_WORKDIR="${CODE_INTERPRETER_WORKDIR:-/workspace}"
JUPYTER_HOST="${JUPYTER_HOST:-127.0.0.1}"
JUPYTER_PORT="${JUPYTER_PORT:-8888}"

mkdir -p "$CODE_INTERPRETER_WORKDIR"

JUPYTER_BASE_URL="http://$JUPYTER_HOST:$JUPYTER_PORT"
export JUPYTER_BASE_URL

jupyter server \
  --IdentityProvider.token="" \
  --ServerApp.ip="$JUPYTER_HOST" \
  --ServerApp.port="$JUPYTER_PORT" \
  --ServerApp.root_dir="$CODE_INTERPRETER_WORKDIR" \
  --ServerApp.allow_root=True \
  --ServerApp.disable_check_xsrf=True \
  --ServerApp.open_browser=False \
  >/var/log/jupyter.log 2>&1 &
echo "[code-interpreter] Jupyter Server started on $JUPYTER_BASE_URL"

exec python3 -m uvicorn \
  --host "$CODE_INTERPRETER_HOST" \
  --port "$CODE_INTERPRETER_PORT" \
  --log-level info \
  --timeout-keep-alive 640 \
  server:app \
  --app-dir /opt/lightweight-code-interpreter
