#!/bin/bash
# macOS 本机打包入口：复用与 Windows 相同的完整桌面构建链路。
set -euo pipefail

# 输出参数说明；帮助模式不检查环境，也不下载依赖。
usage() {
    cat <<'HELP'
用法：./build-macos-installer.sh [选项]
  --proxy URL           本次构建使用的 HTTP/HTTPS 代理
  --compression LEVEL   store / normal / maximum，默认 normal
  --signed              使用现有 Apple 签名配置；默认临时签名内部测试包
  --dry-run             检查环境并显示构建命令，不安装依赖或构建
  -h, --help            显示帮助

生成当前提交、本机架构的 bundled DMG 和 ZIP，输出 apps/desktop/release/。
先执行 source ./activate 准备 .venv，并安装 Node.js 和 Xcode Command Line Tools。
HELP
}

proxy_url=''
compression=normal
signed=false
dry_run=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --proxy|--compression)
            if [[ $# -lt 2 || -z "$2" || "$2" == --* ]]; then
                echo "参数 $1 缺少值" >&2
                exit 2
            fi
            if [[ "$1" == --proxy ]]; then proxy_url="$2"; else compression="$2"; fi
            shift 2
            ;;
        --signed) signed=true; shift ;;
        --dry-run) dry_run=true; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
    esac
done
case "$compression" in
    store|normal|maximum) ;;
    *) echo 'compression 必须为 store、normal 或 maximum' >&2; exit 2 ;;
esac
if [[ -n "$proxy_url" && "$proxy_url" != http://* && "$proxy_url" != https://* ]]; then
    echo '代理地址必须使用 http:// 或 https://' >&2
    exit 2
fi
if [[ "$(uname -s)" != Darwin ]]; then
    echo '请在 macOS 本机执行，包含 Python 和原生模块的安装包不支持在此入口跨平台构建。' >&2
    exit 1
fi
source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$source_root"
python="$source_root/.venv/bin/python"
if [[ ! -x "$python" ]]; then
    echo '缺少 .venv/bin/python，请先在仓库根目录执行 source ./activate。' >&2
    exit 1
fi
for tool in git npm xcrun; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "缺少构建工具：$tool" >&2
        exit 1
    fi
done
xcrun --find clang >/dev/null
xcrun --show-sdk-path >/dev/null
commit="$(git rev-parse --verify HEAD)"
changes="$(git status --porcelain --untracked-files=all)"
if [[ -n "$changes" ]]; then
    echo '源码目录不干净：请提交需要打包的修改，或将无关文件移到仓库外再打包。' >&2
    printf '%s\n' "$changes" >&2
    exit 1
fi
cache_root="$source_root/.cache/desktop-inputs"
work_root="$source_root/.build/desktop-job-macos"
builder_args=("-c.compression=$compression" --publish never)
if [[ "$signed" == true ]]; then
    builder_args+=('-c.forceCodeSigning=true')
else
    # 内部测试不读取证书或触发 Apple 公证；只影响本脚本及其子进程。
    export CSC_IDENTITY_AUTO_DISCOVERY=false
    unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME APPLE_NOTARY_PROFILE APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER
    # 使用固定的临时签名配置，签署内置组件并验证整个应用。
    builder_args+=('--internal-test-signing')
fi
command_args=("$python" scripts/bundles/desktop.py --commit "$commit" --variant bundled
    --work "$work_root" --cache "$cache_root" -- "${builder_args[@]}")
if [[ "$dry_run" == true ]]; then
    echo "源码提交：${commit}；本机构建；签名模式：$signed"
    echo '准备步骤：npm --prefix apps/desktop run connectors:install'
    printf '构建命令：'
    printf '%q ' "${command_args[@]}"
    printf '\n'
    exit 0
fi

mkdir -p "$source_root/.build/temp-macos" "$cache_root"
build_temp="$(mktemp -d "$source_root/.build/temp-macos/job.XXXXXX")"
# 仅清理本次创建的临时目录，保留依赖缓存和构建工作目录。
cleanup() { rm -rf -- "$build_temp"; }
trap cleanup EXIT
export TMPDIR="$build_temp/"
export ELECTRON_BUILDER_CACHE="$cache_root/electron-builder"
export UV_CONCURRENT_INSTALLS=1
if [[ -n "$proxy_url" ]]; then
    export HTTP_PROXY="$proxy_url" HTTPS_PROXY="$proxy_url"
    export NO_PROXY='localhost,127.0.0.1,::1,registry.npmjs.org,files.pythonhosted.org'
    export NODE_USE_ENV_PROXY=1 ELECTRON_GET_USE_PROXY=1
fi
started=$SECONDS
touch "$build_temp/started"
printf '开始构建 macOS 安装包，提交：%s，签名模式：%s\n' "$commit" "$signed"
npm --prefix apps/desktop run connectors:install
"${command_args[@]}"

# 必须找到本次生成的两类文件，不能把上一次的安装包误报为本次成功。
shopt -s nullglob
found_dmg=false
found_zip=false
for artifact in "$source_root/apps/desktop/release/"*.dmg "$source_root/apps/desktop/release/"*.zip; do
    if [[ -f "$artifact" && "$artifact" -nt "$build_temp/started" ]]; then
        case "$artifact" in *.dmg) found_dmg=true ;; *.zip) found_zip=true ;; esac
        printf '产物：%s\n' "$artifact"
    fi
done
if [[ "$found_dmg" != true || "$found_zip" != true ]]; then
    echo '构建结束但没有找到本次生成的 DMG 和 ZIP，请检查 apps/desktop/release/。' >&2
    exit 1
fi
printf 'macOS 打包完成，耗时 %s 秒。\n' "$((SECONDS - started))"
