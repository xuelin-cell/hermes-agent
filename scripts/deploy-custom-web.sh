#!/usr/bin/env bash
# Deploy the custom browser frontend and backend from the current checkout.
#
# This script intentionally does not pull source code, edit nginx, restart
# Docker, or prune shared images/volumes. It is safe to run alongside the
# separately managed 1Panel Hermes installation.

set -Eeuo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RUNTIME_DIR="${RUNTIME_DIR:-/mnt/hermes-runtime}"
COMPOSE_FILE="${COMPOSE_FILE:-${RUNTIME_DIR}/compose.yaml}"
ENV_FILE="${ENV_FILE:-${RUNTIME_DIR}/hermes.env}"
WEB_PATH="${WEB_PATH:-${RUNTIME_DIR}/hermes}"
RELEASES_DIR="${RELEASES_DIR:-${RUNTIME_DIR}/releases}"
IMAGE_REPO="${IMAGE_REPO:-hermes-custom}"
CONTAINER_NAME="${CONTAINER_NAME:-hermes-custom-backend}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:9120/api/health}"
S6_OVERLAY_BASE_URL="${S6_OVERLAY_BASE_URL:-https://ghproxy.net/https://github.com/just-containers/s6-overlay/releases/download}"
BUILD_CPUS="${BUILD_CPUS:-4}"
BUILD_MEMORY="${BUILD_MEMORY:-8g}"

log() {
    printf '\n==> %s\n' "$*"
}

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker compose version >/dev/null 2>&1 || die "docker compose is unavailable"
command -v curl >/dev/null 2>&1 || die "curl is not installed"
command -v flock >/dev/null 2>&1 || die "flock is not installed"

[[ -f "${REPO}/Dockerfile" ]] || die "Dockerfile not found under ${REPO}"
[[ -f "${REPO}/apps/desktop/package.json" ]] || die "desktop package.json not found"
[[ -s "${ENV_FILE}" ]] || die "missing environment file: ${ENV_FILE}"
[[ -f "${COMPOSE_FILE}" ]] || die "missing compose file: ${COMPOSE_FILE}"

exec 9>"${RUNTIME_DIR}/deploy.lock"
flock -n 9 || die "another custom Hermes deployment is already running"

cd "${REPO}"
git diff --quiet || die "tracked working-tree changes found; commit or stash them first"
git diff --cached --quiet || die "staged changes found; commit or unstage them first"

REVISION="$(git rev-parse --short HEAD)"
STAMP="$(date +%Y%m%d-%H%M%S)"
VERSION_IMAGE="${IMAGE_REPO}:${REVISION}"
DEV_IMAGE="${IMAGE_REPO}:dev"
ROLLBACK_IMAGE="${IMAGE_REPO}:rollback"
FRONTEND_RELEASE="${RELEASES_DIR}/${REVISION}-${STAMP}"

log "Deploying revision ${REVISION}"
docker compose -p hermes-custom -f "${COMPOSE_FILE}" config --quiet

TOKEN_LENGTH="$(grep '^HERMES_DASHBOARD_SESSION_TOKEN=' "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '\r\n' | wc -c | tr -d ' ')"
[[ "${TOKEN_LENGTH}" == "64" ]] || die "dashboard session token is missing or not 64 characters"

log "Building custom browser frontend"
docker run --rm \
    --name hermes-custom-frontend-builder \
    --cpus "${BUILD_CPUS}" \
    --memory "${BUILD_MEMORY}" \
    -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    -v "${REPO}:/workspace" \
    -v hermes-custom-root-node-modules:/workspace/node_modules \
    -v hermes-custom-desktop-node-modules:/workspace/apps/desktop/node_modules \
    -w /workspace/apps/desktop \
    node:22-bookworm \
    sh -lc '
        npm install --no-audit --no-fund --package-lock=false &&
        VITE_HERMES_BROWSER_BUILD=1 \
        node /workspace/node_modules/vite/bin/vite.js \
            build --base=/hermes/ --outDir=dist-browser
    '

[[ -f "${REPO}/apps/desktop/dist-browser/index.html" ]] || die "frontend build did not produce index.html"
git diff --quiet || die "frontend build modified tracked files; deployment stopped"
git diff --cached --quiet || die "frontend build staged tracked files; deployment stopped"

log "Staging frontend release ${FRONTEND_RELEASE}"
mkdir -p "${FRONTEND_RELEASE}"
cp -a "${REPO}/apps/desktop/dist-browser/." "${FRONTEND_RELEASE}/"
chmod -R a+rX "${FRONTEND_RELEASE}"

if docker image inspect "${DEV_IMAGE}" >/dev/null 2>&1; then
    log "Saving current backend image as ${ROLLBACK_IMAGE}"
    docker tag "${DEV_IMAGE}" "${ROLLBACK_IMAGE}"
fi

log "Building backend image ${VERSION_IMAGE}"
docker build \
    --cpu-quota="$((BUILD_CPUS * 100000))" \
    --cpu-period=100000 \
    --memory="${BUILD_MEMORY}" \
    --build-arg "S6_OVERLAY_BASE_URL=${S6_OVERLAY_BASE_URL}" \
    --label hermes.deployment=custom-development \
    --label "hermes.revision=${REVISION}" \
    -t "${VERSION_IMAGE}" \
    -t "${DEV_IMAGE}" \
    "${REPO}"

rollback_backend() {
    if ! docker image inspect "${ROLLBACK_IMAGE}" >/dev/null 2>&1; then
        return 1
    fi
    log "Health check failed; rolling backend back to the previous image"
    docker tag "${ROLLBACK_IMAGE}" "${DEV_IMAGE}"
    docker compose -p hermes-custom -f "${COMPOSE_FILE}" up -d --force-recreate --no-deps backend
}

log "Recreating only ${CONTAINER_NAME}"
docker compose -p hermes-custom -f "${COMPOSE_FILE}" up -d --force-recreate --no-deps backend

log "Waiting for backend health"
healthy=0
for attempt in $(seq 1 30); do
    if curl -fsS --max-time 3 "${HEALTH_URL}" >/dev/null 2>&1; then
        healthy=1
        break
    fi
    sleep 2
done

if [[ "${healthy}" != "1" ]]; then
    docker logs --tail 100 "${CONTAINER_NAME}" >&2 || true
    rollback_backend || true
    die "new backend did not become healthy"
fi

log "Publishing frontend"
mkdir -p "${RELEASES_DIR}"
if [[ -d "${WEB_PATH}" && ! -L "${WEB_PATH}" ]]; then
    mv "${WEB_PATH}" "${RELEASES_DIR}/pre-versioned-${STAMP}"
fi

NEXT_LINK="${RUNTIME_DIR}/.hermes-next-${STAMP}"
ln -s "${FRONTEND_RELEASE}" "${NEXT_LINK}"
mv -Tf "${NEXT_LINK}" "${WEB_PATH}"

git diff --quiet || die "deployment modified tracked working-tree files"
git diff --cached --quiet || die "deployment modified staged files"

log "Deployment complete"
printf 'Revision: %s\n' "${REVISION}"
printf 'Backend:  %s\n' "${VERSION_IMAGE}"
printf 'Frontend: %s -> %s\n' "${WEB_PATH}" "${FRONTEND_RELEASE}"
printf 'Health:   %s\n' "${HEALTH_URL}"
printf '\nOld versioned images and frontend releases were retained for rollback.\n'
