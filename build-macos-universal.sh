#!/bin/bash
# 使用同一提交的两份原生 .app，组装一个临时签名 Universal DMG。
set -euo pipefail
source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ "${1:-}" == --help || $# -eq 0 ]]; then
    echo '用法：./build-macos-universal.sh --x64-app /路径/Intel/UniWork.app --arm64-app /路径/AppleSilicon/UniWork.app --out /新的输出目录'
    echo '先在两种架构的原生构建环境从同一提交运行 build-macos-installer.sh，再提供生成的 .app。'
    exit 0
fi
if [[ "$(uname -s)" != Darwin ]]; then
    echo 'Universal 组装必须在 macOS 执行。' >&2
    exit 1
fi
cd "$source_root"
export HERMES_PYTHON="$source_root/.venv/bin/python"
node apps/desktop/scripts/macos-universal.mjs "$@"
