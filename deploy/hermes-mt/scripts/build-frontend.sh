#!/usr/bin/env bash
# 把 apps/desktop 的 Electron renderer 构建成浏览器版静态 SPA，输出到 deploy/hermes-mt/nginx/dist-browser/。
# 与 scripts/deploy-custom-web.sh 的前端步骤一致（同一条 vite 命令、同一个 --base=/hermes/），
# 只是不动 Nginx、不做 release 目录。Linux 宿主上直接跑；需要 docker。
#   bash deploy/hermes-mt/scripts/build-frontend.sh                构建
#   bash deploy/hermes-mt/scripts/build-frontend.sh --fingerprint  只打印前端指纹，不构建
# 产物不进 git。./deploy.sh all / up 会比对产物里的指纹（dist-browser/.source-fingerprint）和当前代码的，
# 不一样就自己调这个脚本重建，一般不用手工跑。
# npm 仓库默认走 npmmirror（内网到官方仓库慢或不通），要换用 NPM_REGISTRY=... 覆盖。
# 锁文件里不在 npm 仓库的包（xlsx 从 cdn.sheetjs.com 下，部署机连它极慢）放在 deploy/hermes-mt/vendor/npm/，
# 装依赖前按校验值放进 npm 缓存，npm ci 就不再去下载（tests/hermes_mt/test_frontend_vendor.py 核对）。
set -Eeuo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="$REPO/deploy/hermes-mt/nginx/dist-browser"
BUILD_CPUS="${BUILD_CPUS:-4}"
BUILD_MEMORY="${BUILD_MEMORY:-8g}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

# 前端指纹也包含登录页与 renderer 共用的浏览器凭据模块。
# 只看已提交的（部署机上 pull 是 reset --hard，工作区就是 HEAD）。部署机的 git 是 1.8，不用 -C。
fingerprint() {
    (cd "$REPO" && git ls-tree HEAD apps package.json package-lock.json .npmrc \
        deploy/hermes-mt/scripts/build-frontend.sh deploy/hermes-mt/vendor/npm) | sha256sum | cut -c1-12
}
if [ "${1:-}" = --fingerprint ]; then
    fingerprint
    exit 0
fi

# Distribute the canonical browser auth module to the standalone Entry login page.
{ printf '%s\n' '// Generated from apps/shared/src/browser-maas-auth.js by build-frontend.sh.';
  cat "$REPO/apps/shared/src/browser-maas-auth.js"; } > "$REPO/deploy/hermes-mt/entry/entry/static/browser-auth.js"
FINGERPRINT="$(fingerprint)"

docker run --rm \
    --name hermes-mt-frontend-builder \
    --cpus "$BUILD_CPUS" --memory "$BUILD_MEMORY" \
    -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    -e PUPPETEER_SKIP_DOWNLOAD=1 \
    -e npm_config_registry="$NPM_REGISTRY" \
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
            for tgz in /workspace/deploy/hermes-mt/vendor/npm/*.tgz; do npm cache add "$tgz" >/dev/null; done
            npm ci --workspace apps/desktop --include-workspace-root --no-audit --no-fund
            printf "%s\n" "${deps_hash}" > "${deps_stamp}"
        fi
        cd /workspace/apps/desktop
        VITE_HERMES_BROWSER_BUILD=1 node /workspace/node_modules/vite/bin/vite.js build --base=/hermes/ --outDir=dist-browser
    '

[[ -f "$REPO/apps/desktop/dist-browser/index.html" ]] || { echo "前端构建没有产出 index.html" >&2; exit 1; }
rm -rf "$OUT"
cp -a "$REPO/apps/desktop/dist-browser" "$OUT"
# 构建成功才写指纹：deploy.sh 靠它判断产物是不是当前代码构建的。nginx/.dockerignore 不让它进镜像。
printf '%s\n' "$FINGERPRINT" > "$OUT/.source-fingerprint"
echo "前端已就位: $OUT ($(find "$OUT" -type f ! -name .source-fingerprint | wc -l) 个文件，指纹 $FINGERPRINT)"
