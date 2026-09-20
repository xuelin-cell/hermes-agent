#!/usr/bin/env bash
# 把 apps/desktop 的 Electron renderer 构建成浏览器版静态 SPA，输出到 deploy/hermes-mt/nginx/dist-browser/。
# 与 scripts/deploy-custom-web.sh 的前端步骤一致（同一条 vite 命令、同一个 --base=/hermes/），
# 只是不动 Nginx、不做 release 目录。Linux 宿主上直接跑；需要 docker。
#   bash deploy/hermes-mt/scripts/build-frontend.sh
set -Eeuo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="$REPO/deploy/hermes-mt/nginx/dist-browser"
BUILD_CPUS="${BUILD_CPUS:-4}"
BUILD_MEMORY="${BUILD_MEMORY:-8g}"

docker run --rm \
    --name hermes-mt-frontend-builder \
    --cpus "$BUILD_CPUS" --memory "$BUILD_MEMORY" \
    -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    -v "$REPO:/workspace" \
    -v hermes-custom-root-node-modules:/workspace/node_modules \
    -v hermes-custom-desktop-node-modules:/workspace/apps/desktop/node_modules \
    -v hermes-custom-npm-cache:/root/.npm \
    -w /workspace \
    node:22-bookworm \
    sh -lc '
        deps_hash="$(sha256sum package.json package-lock.json apps/desktop/package.json apps/shared/package.json | sha256sum | cut -d" " -f1)"
        deps_stamp=/workspace/node_modules/.hermes-desktop-deps-hash
        if [ "${deps_hash}" != "$(cat "${deps_stamp}" 2>/dev/null || true)" ] || [ ! -f /workspace/node_modules/vite/bin/vite.js ]; then
            npm ci --workspace apps/desktop --include-workspace-root --no-audit --no-fund
            printf "%s\n" "${deps_hash}" > "${deps_stamp}"
        fi
        cd /workspace/apps/desktop
        VITE_HERMES_BROWSER_BUILD=1 node /workspace/node_modules/vite/bin/vite.js build --base=/hermes/ --outDir=dist-browser
    '

[[ -f "$REPO/apps/desktop/dist-browser/index.html" ]] || { echo "前端构建没有产出 index.html" >&2; exit 1; }
rm -rf "$OUT"
cp -a "$REPO/apps/desktop/dist-browser" "$OUT"
echo "前端已就位: $OUT ($(find "$OUT" -type f | wc -l) 个文件)"
