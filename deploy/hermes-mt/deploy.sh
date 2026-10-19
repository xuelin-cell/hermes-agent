#!/usr/bin/env bash
# 多租户栈的一键部署 / 升级脚本。在部署机上以 root 运行，工作目录随意。
#
#   ./deploy.sh all            一键：拉代码 → 基础镜像(按需) → 前端(按需) → 只读检查 → 沙箱镜像(按需) → 模板(按需) → 起容器 → 验收
#   ./deploy.sh base           拉代码 → 只建基础镜像（hermes 本体，15~45 分钟；按 hermes 源码指纹命名，源码没变就跳过）。
#                              all 缺当前指纹的基础镜像会自己先建，一般不用单独跑
#   ./deploy.sh check          只读摸底，不改任何东西
#   ./deploy.sh image          构建沙箱镜像并推到集群仓库（内容没变就跳过推送）
#   ./deploy.sh template       确保集群上有当前镜像的模板，把模板 ID 写进 entry.env
#   ./deploy.sh up             启动 / 更新三个容器（前端不是当前代码构建的先重建；入口重建后自动重启 nginx）
#   ./deploy.sh log            看部署进度：在跑就接着实时看，跑完了打出最后几十行和结果
#   ./deploy.sh status         看现状：容器、PG 里的租户、集群上的实例和模板
#   ./deploy.sh purge-old      删掉不在当前模板上的实例（会问确认；只有旧转发器的实例才需要）
#   ./deploy.sh purge-templates [--api URL]  删掉我们不再用的模板：保留当前和上一版，有实例在用的不删（会问确认）
#   ./deploy.sh set KEY=VALUE… 改 entry.env 里的一项或几项（只认 MT_ 开头），然后提示你跑 up 生效
#   ./deploy.sh init --http-port IP:端口 --cube-api URL --cube-proxy URL [--registry HOST:PORT]
#                              首次部署：生成 entry.env（密钥现场随机、600）和 compose.override.yaml
#   选项：--no-pull（all / base 时不拉代码）  --branch 名字  --yes（不问确认）
#   all / base / image / template / up 在终端里敲：部署在后台跑，屏幕上实时显示进度；Ctrl+C、终端断开都只是不看了，
#   部署照样跑完（./deploy.sh log 接着看）。同一时间只跑一次部署；每次的日志在 .deploy-logs/。
#
# 为什么要有这个脚本：手册里的每一步都有能出错的细节（构建器、不安全仓库、模板要和入口一起换、
# 入口重建后 nginx 要重启、entry.env 权限……），漏一条就是线上事故。这里把它们全部变成
# 检查项和自动步骤，人只需要跑一条命令、看一份摘要。
#
# 沙箱镜像按「内容指纹」命名，不按提交号：指纹 = Dockerfile.cube + seed/* + overlay.list 列的仓库文件 + 基础镜像 ID + 模板参数。
# overlay.list 列本分支在 hermes 源码上的改动和新增（仓库路径），构建前原样拷进 .overlay/，按原路径覆盖进镜像的 /opt/hermes。
# 只改入口代码时镜像和模板一个都不会重做；改了转发器就一定重做。入口发现实例的模板和配置里的
# 不一致，会在用户下次请求时自动排空、删除、重建、恢复（见 seed/mtstate.py），不用手工删实例。
#
# 部署机上的硬规矩（共享生产机）：不重启 Docker、不改 daemon 配置、不 prune、不切换默认构建器
# （每条构建命令前加 BUILDX_BUILDER=default）、页面只绑内网 IP、compose 永远带 --env-file、
# 不打印任何密钥。本脚本只做这些之内的事。
#
# 配置全部从 entry.env 读。除入口自己的变量外，部署专用的几项（都有默认值）：
#   MT_DEPLOY_REGISTRY      集群镜像仓库 HOST:PORT，默认 = MT_CUBE_API 的主机 + :5000
#   MT_DEPLOY_BASE_IMAGE    沙箱镜像的基础镜像，默认 hermes-custom:src-<hermes 源码指纹>（./deploy.sh base 构建）；
#                           一般不要设，设了就固定用它（必须已在本机）
#   MT_DEPLOY_SEED_DIR      ./deploy.sh base 预置大文件的目录，默认 /var/cache/hermes-mt/base-seed（约 500M，可重复用）
#   MT_DEPLOY_TPL_CPU/MEM   模板规格，默认 2000 / 2000（毫核 / MiB）
#   MT_DEPLOY_TPL_DISK      模板可写层，默认 8G
#   MT_DEPLOY_TPL_RETRIES   建模板有节点失败（平台偶发）时重建几次，第一次之外，默认 3
#   MT_DEPLOY_BRANCH        all 时拉哪个分支，默认当前分支
#   MT_DEPLOY_FWD_PORT      推镜像用的本机临时转发端口，默认 15000
#
# 前端（nginx/dist-browser/）不进 git，由 scripts/build-frontend.sh 从本仓库构建，构建时把前端指纹
# （apps/、根目录的依赖声明、构建脚本、预置的 npm 包）写进产物。all 和 up 比对它和当前代码的指纹，
# 对不上就先重新构建（5~10 分钟），不会把旧前端发出去。

set -euo pipefail

SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
HERE="$(cd "$(dirname "$SCRIPT")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ENV_FILE="$HERE/entry.env"
OVERRIDE="$HERE/compose.override.yaml"
HISTORY="$HERE/.deploy-history"
LOG_DIR="$HERE/.deploy-logs"
RUNNING="$HERE/.deploy-running"      # 正在跑的那次部署：第 1 行进程号，第 2 行命令和开始时间，第 3 行日志
LAST_EXIT="$HERE/.deploy-last-exit"  # 上一次部署的退出码
PROJECT=hermes-mt
IMAGE_NAME=hermes-mt-cube
REPO_PATH=hermes-mt/hermes-mt-cube

YES=0
NO_PULL=0
BRANCH_OPT=""
FWD_PID=""
FWD_REF=""

# 推镜像时起的后台转发进程和临时标签：不管脚本怎么退出都要收掉。
# 杀掉后等它退出：不等的话部署机的 bash（4.2）会把整段转发脚本连同「Terminated」打出来，像出了错。
cleanup() {
    local rc=$?
    if [ -n "$FWD_PID" ]; then kill "$FWD_PID" 2>/dev/null || true; wait "$FWD_PID" 2>/dev/null || true; FWD_PID=""; fi
    if [ -n "$FWD_REF" ]; then docker rmi "$FWD_REF" >/dev/null 2>&1 || true; FWD_REF=""; fi
    # 这次部署登记过「正在跑」：结束时记下退出码、撤掉登记（前台跟进度的和 ./deploy.sh log 要看）。
    if [ "$(sed -n 1p "$RUNNING" 2>/dev/null || true)" = "$$" ]; then
        printf '%s\n' "$rc" > "$LAST_EXIT"
        rm -f "$RUNNING"
    fi
}
trap cleanup EXIT

# ---------------------------------------------------------------- 输出

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m[通过]\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m[注意]\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m[停止]\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少命令 $1"; }

confirm() {
    [ "$YES" = 1 ] && return 0
    printf '%s [y/N] ' "$1"
    read -r answer
    [ "$answer" = y ] || [ "$answer" = Y ]
}

# ---------------------------------------------------------------- 配置

# 只取指定键，绝不整份读出来——entry.env 里有密钥。
cfg() {
    local key="$1" default="${2-}"
    local line
    line="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 || true)"
    if [ -n "$line" ]; then
        printf '%s' "${line#*=}"
    else
        printf '%s' "$default"
    fi
}

set_cfg() {
    local key="$1" value="$2"
    if grep -qE "^${key}=" "$ENV_FILE"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    else
        printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    fi
    chmod 600 "$ENV_FILE"
}

load_cfg() {
    [ -f "$ENV_FILE" ] || die "没有 $ENV_FILE。首次部署先跑：./deploy.sh init --http-port IP:端口 --cube-api URL --cube-proxy URL"
    CUBE_API="$(cfg MT_CUBE_API)"
    CUBE_PROXY="$(cfg MT_CUBE_PROXY)"
    BACKEND="$(cfg MT_BACKEND docker)"
    HTTP_PORT="$(cfg MT_HTTP_PORT 18081)"
    DEV_LOGIN="$(cfg MT_DEV_LOGIN 0)"
    TEMPLATE="$(cfg MT_CUBE_TEMPLATE)"
    local api_host
    api_host="$(printf '%s' "$CUBE_API" | sed -E 's|^[a-z]+://||; s|[:/].*$||')"
    REGISTRY="$(cfg MT_DEPLOY_REGISTRY "${api_host}:5000")"
    BASE_IMAGE="$(cfg MT_DEPLOY_BASE_IMAGE "$(base_tag)")"
    TPL_CPU="$(cfg MT_DEPLOY_TPL_CPU 2000)"
    TPL_MEM="$(cfg MT_DEPLOY_TPL_MEM 2000)"
    TPL_DISK="$(cfg MT_DEPLOY_TPL_DISK 8G)"
    TPL_RETRIES="$(cfg MT_DEPLOY_TPL_RETRIES 3)"
    FWD_PORT="$(cfg MT_DEPLOY_FWD_PORT 15000)"
    BRANCH="${BRANCH_OPT:-$(cfg MT_DEPLOY_BRANCH "$(g rev-parse --abbrev-ref HEAD)")}"
}

compose() {
    BUILDX_BUILDER=default docker compose --env-file "$ENV_FILE" -p "$PROJECT" "$@"
}

api() {  # api GET /templates
    curl -sS -m 30 -X "$1" -H 'Content-Type: application/json' "${@:3}" "$CUBE_API$2"
}

py() { python3 -c "$@"; }

# 部署机的 git 是 1.8（没有 -C、没有 --is-shallow-repository），只用老版本也有的用法。
g() { (cd "$REPO" && git "$@"); }
head_short() { g rev-parse --short=7 HEAD; }

# 基础镜像（hermes 本体）按 hermes 源码指纹命名：当前提交里除前端、部署、文档、测试之外的文件。
# 这些没变就不用重建（构建要 15~45 分钟）。git 1.8 没有排除式路径，用 ls-tree 自己滤。
base_tag() {
    printf 'hermes-custom:src-%s' "$(g ls-tree -r HEAD | grep -vE $'\t(apps|deploy|docs|tests|website)/' | sha256sum | cut -c1-12)"
}

# 前端产物是不是当前代码构建的：比对 scripts/build-frontend.sh 算的指纹和它构建时写进产物的那份。
frontend_want() { bash "$HERE/scripts/build-frontend.sh" --fingerprint; }
frontend_have() { cat "$HERE/nginx/dist-browser/.source-fingerprint" 2>/dev/null || true; }
frontend_current() {
    [ -s "$HERE/nginx/dist-browser/index.html" ] && [ "$(frontend_have)" = "$(frontend_want)" ]
}
frontend_files() { find "$HERE/nginx/dist-browser" -type f ! -name .source-fingerprint | wc -l; }

# ---------------------------------------------------------------- 指纹

fingerprint() {
    local base_id
    base_id="$(docker image inspect --format '{{.Id}}' "$BASE_IMAGE" 2>/dev/null || true)"
    [ -n "$base_id" ] || die "基础镜像 $BASE_IMAGE 不在本机：hermes 源码变了或第一次部署，先跑 ./deploy.sh base"
    {
        cat "$HERE/Dockerfile.cube"
        # config.yaml.tmpl 由入口渲染后经引导接口送进实例，不在镜像里，改它不必换模板。
        for f in "$HERE"/seed/*; do
            [ -f "$f" ] || continue
            case "$f" in */config.yaml.tmpl) continue ;; esac
            printf 'seed/%s\n' "$(basename "$f")"; cat "$f"
        done
        for f in $(overlay_files); do
            printf 'overlay/%s\n' "$f"; cat "$REPO/$f"
        done
        printf 'base=%s\ntpl=%s/%s/%s\n' "$base_id" "$TPL_CPU" "$TPL_MEM" "$TPL_DISK"
    } | sha256sum | cut -c1-12
}

# overlay.list 里的条目（去掉注释和空行）：仓库路径，目录表示其下全部受版本管理的文件。
overlay_entries() {
    sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^[[:space:]]*$/d' "$HERE/overlay.list"
}

# 条目展开成文件：相对仓库根、只算受版本管理的、顺序固定。它们按原路径覆盖进镜像的 /opt/hermes（见 Dockerfile.cube）。
overlay_files() {
    local p
    overlay_entries | while read -r p; do
        (cd "$REPO" && git ls-files -- "$p")
    done | LC_ALL=C sort -u
}

# 清单里每一项都得是仓库里受版本管理的路径，否则镜像里少东西却没人发现。
check_overlay() {
    local p n
    [ -f "$HERE/overlay.list" ] || die "缺少 $HERE/overlay.list（覆盖进镜像的仓库路径，Dockerfile.cube 要用）"
    for p in $(overlay_entries); do
        [ -n "$(cd "$REPO" && git ls-files -- "$p")" ] || die "overlay.list 里的 $p 不是仓库里受版本管理的路径"
    done
    n="$(overlay_files | wc -l | tr -d ' ')"
    ok "覆盖进镜像的仓库文件 $n 个（overlay.list）"
}

# 构建前把清单里的文件原样拷进 .overlay/（构建目录，不进 git），Dockerfile.cube 从那里覆盖进 /opt/hermes。
stage_overlay() {
    rm -rf "$HERE/.overlay"
    mkdir -p "$HERE/.overlay"
    (cd "$REPO" && overlay_files | tar -cf - -T -) | tar -xf - -C "$HERE/.overlay"
}

# ---------------------------------------------------------------- 集群查询

registry_has_tag() {
    curl -s -m 10 "http://$REGISTRY/v2/$REPO_PATH/tags/list" | py '
import json,sys
try: tags = json.load(sys.stdin).get("tags") or []
except Exception: tags = []
sys.exit(0 if sys.argv[1] in tags else 1)' "$1"
}

# 集群上有没有「镜像 = 当前指纹」且 READY 的模板；有就打印它的 ID。
template_for_tag() {
    api GET /templates 2>/dev/null | py '
import json,sys
tag = sys.argv[1]
try: items = json.load(sys.stdin)
except Exception: items = []
for t in items:
    if t.get("status") == "READY" and ("/%s:%s@" % (sys.argv[2], tag)) in (t.get("imageInfo") or ""):
        print(t["templateID"]); break' "$1" "$REPO_PATH" || true
}

our_sandboxes() {  # 每行: sandboxID state templateID node slug
    api GET /sandboxes 2>/dev/null | py '
import json,sys
try: items = json.load(sys.stdin)
except Exception: items = []
for s in items:
    m = s.get("metadata") or {}
    if m.get("hermes.mt") == "tenant":
        print(s["sandboxID"], s.get("state"), s.get("templateID"), s.get("clientID"), (m.get("hermes.mt.slug") or "")[:10])' || true
}

foreign_containers() { docker ps --format '{{.Names}}' | grep -vc "^${PROJECT}-" || true; }

# ---------------------------------------------------------------- init

cmd_init() {
    local http_port="" cube_api="" cube_proxy="" registry=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --http-port) http_port="$2"; shift 2 ;;
            --cube-api) cube_api="$2"; shift 2 ;;
            --cube-proxy) cube_proxy="$2"; shift 2 ;;
            --registry) registry="$2"; shift 2 ;;
            *) die "init 不认识的参数 $1" ;;
        esac
    done
    [ -n "$http_port" ] && [ -n "$cube_api" ] && [ -n "$cube_proxy" ] || die "init 需要 --http-port IP:端口 --cube-api URL --cube-proxy URL"
    printf '%s' "$http_port" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+$' || die "--http-port 必须写成 IP:端口（只绑内网 IP，不能只写端口）"
    [ -e "$ENV_FILE" ] && die "$ENV_FILE 已存在，不覆盖"
    need openssl
    say "生成 entry.env（密钥现场随机，只有 root 能读）"
    local pgpw fkey
    pgpw="$(openssl rand -hex 16)"
    fkey="$(openssl rand -base64 32 | tr '+/' '-_')"
    umask 077
    cat > "$ENV_FILE" <<EOT
MT_POSTGRES_DB=hermes_entry
MT_POSTGRES_USER=hermes_entry
MT_POSTGRES_PASSWORD=$pgpw
MT_POSTGRES_PORT=15432
MT_DATABASE_URL=postgresql://hermes_entry:$pgpw@postgres:5432/hermes_entry
MT_CREDENTIAL_KEY=$fkey
MT_HTTP_PORT=$http_port
PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
MT_BACKEND=cube
MT_CUBE_API=$cube_api
MT_CUBE_PROXY=$cube_proxy
MT_CUBE_DOMAIN=cube.app
MT_CUBE_TEMPLATE=
MT_CUBE_VOLUME_MOUNT=/mnt/u
MT_PREFIX=hermes-mt
MT_DEV_LOGIN=0
MT_COOKIE_SECURE=0
MT_TZ=Asia/Shanghai
MT_IDLE_MINUTES=30
MT_IDLE_DELETE_HOURS=0
EOT
    [ -n "$registry" ] && printf 'MT_DEPLOY_REGISTRY=%s\n' "$registry" >> "$ENV_FILE"
    unset pgpw fkey
    chmod 600 "$ENV_FILE"
    ensure_override
    ok "写好了 $ENV_FILE（模板 ID 由 ./deploy.sh template 填）"
}

# 入口在沙箱后端下不需要 docker.sock；compose.yaml 为 Docker 后端挂了它，这里用覆盖文件去掉。
ensure_override() {
    if [ ! -f "$OVERRIDE" ]; then
        cat > "$OVERRIDE" <<'EOT'
services:
  entry:
    volumes: !reset []
EOT
        ok "生成 compose.override.yaml（去掉入口对 docker.sock 的挂载）"
    fi
    local exclude="$REPO/.git/info/exclude"
    if [ -d "$REPO/.git" ] && ! grep -qxF 'deploy/hermes-mt/compose.override.yaml' "$exclude" 2>/dev/null; then
        printf 'deploy/hermes-mt/compose.override.yaml\n' >> "$exclude"
    fi
}

# ---------------------------------------------------------------- pull

cmd_pull() {
    say "拉代码：分支 $BRANCH"
    cd "$REPO"
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
        git status --short --untracked-files=no | head -10
        die "工作区有未提交的改动，不敢 reset。先处理掉再来。"
    fi
    if [ -f "$REPO/.git/shallow" ]; then
        git fetch --depth 1 origin "$BRANCH"
    else
        git fetch origin "$BRANCH"
    fi
    local before after crlf
    before="$(git rev-parse --short=7 HEAD)"
    git reset -q --hard FETCH_HEAD
    after="$(git rev-parse --short=7 HEAD)"
    ok "HEAD: $before -> $after  $(git log -1 --format=%s | cut -c1-60)"
    # 只查受版本管理的文件：base 的构建日志（apt、pip 的进度条带 CR）、前端产物这些生成的文件不算检出出错。
    crlf="$(cd "$HERE" && git ls-files -z | xargs -0 -r grep -lI $'\r' 2>/dev/null || true)"
    if [ -n "$crlf" ]; then
        die "部署目录里有带 CR 的文件（检出时行尾没保住），不能继续：$(printf '%s\n' "$crlf" | head -n 3 | tr '\n' ' ')"
    fi
}

# ---------------------------------------------------------------- check

cmd_check() {
    say "只读检查"
    need docker; need curl; need python3; need git; need ss; need sha256sum
    docker info >/dev/null 2>&1 || die "docker 不可用（要以 root 跑）"

    local cv
    cv="$(docker compose version --short 2>/dev/null || echo 0)"
    py 'import sys; v=tuple(int(x) for x in sys.argv[1].split(".")[:2]); sys.exit(0 if v>=(2,24) else 1)' "$cv" \
        && ok "docker compose $cv" || die "docker compose $cv 太旧（覆盖文件的 !reset 语法要 2.24+）"
    docker buildx ls 2>/dev/null | grep -qE '^default\b' && ok "构建器 default 存在" || die "没有 default 构建器"

    [ "$(stat -c %a "$ENV_FILE")" = 600 ] && ok "entry.env 权限 600" || warn "entry.env 权限不是 600（$(stat -c %a "$ENV_FILE")），会在写配置时修正"
    [ "$BACKEND" = cube ] && ok "后端 cube" || die "MT_BACKEND=$BACKEND，本脚本只管沙箱后端"
    printf '%s' "$HTTP_PORT" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+$' \
        && ok "页面只绑 $HTTP_PORT" || die "MT_HTTP_PORT=$HTTP_PORT 没带 IP，会绑到所有网卡；写成 IP:端口"
    [ "$DEV_LOGIN" = 0 ] && ok "开发登录已关" || die "MT_DEV_LOGIN=$DEV_LOGIN，生产必须是 0"
    [ -n "$CUBE_API" ] && [ -n "$CUBE_PROXY" ] || die "MT_CUBE_API / MT_CUBE_PROXY 没配"
    [ -f "$OVERRIDE" ] && grep -q '!reset' "$OVERRIDE" && ok "compose.override.yaml 去掉了 docker.sock" || warn "没有 compose.override.yaml，起容器前会自动生成"

    if docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
        ok "基础镜像 $BASE_IMAGE 在本机"
    elif [ "$BASE_IMAGE" = "$(base_tag)" ]; then
        warn "基础镜像 $BASE_IMAGE 不在本机（hermes 源码变了或第一次部署）：all 会先构建，15~45 分钟"
    else
        die "entry.env 固定的基础镜像 $BASE_IMAGE 不在本机（MT_DEPLOY_BASE_IMAGE 固定的不会自动构建）"
    fi
    check_overlay
    if frontend_current; then
        ok "前端产物 $(frontend_files) 个文件，是当前代码构建的"
    else
        warn "前端产物不在或不是当前代码构建的：all / up 会先重新构建，5~10 分钟"
    fi

    local code
    code="$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$CUBE_API/templates" || true)"
    [ "$code" = 200 ] && ok "控制面 $CUBE_API 可达" || die "控制面 $CUBE_API 不可达（HTTP $code）"
    code="$(curl -s -m 8 -o /dev/null -w '%{http_code}' "http://$REGISTRY/v2/" || true)"
    { [ "$code" = 200 ] || [ "$code" = 401 ]; } && ok "镜像仓库 $REGISTRY 可达" || die "镜像仓库 $REGISTRY 不可达（HTTP $code）；用 MT_DEPLOY_REGISTRY 指定"
    ss -lnt | grep -qE ":${FWD_PORT}[[:space:]]" && die "本机端口 $FWD_PORT 被占（推镜像要用），换 MT_DEPLOY_FWD_PORT" || ok "临时转发端口 $FWD_PORT 空闲"

    local img
    for img in python:3.13-slim nginx:1.27-alpine postgres:18.6-bookworm; do
        docker image inspect "$img" >/dev/null 2>&1 || warn "本机没有 $img，起容器时会去拉；镜像源元数据对不上时按手册先按摘要拉"
    done
    local free_g
    free_g="$(df -BG --output=avail / | tail -1 | tr -dc 0-9)"
    [ "${free_g:-0}" -ge 5 ] && ok "根分区剩余 ${free_g}G" || warn "根分区只剩 ${free_g}G"
    ok "别人的容器 $(foreign_containers) 个（部署后要一样）"
    ok "代码 $(head_short)  $(g log -1 --format=%s | cut -c1-50)"
    ok "当前模板 ${TEMPLATE:-（未设置）}"
}

# ---------------------------------------------------------------- base

# 基础镜像 = 本仓库根目录的 Dockerfile（和桌面版同一份）构建出来的 hermes 本体：hermes 代码、内置技能、
# pm 锁定的 Python / Node / Chromium / ffmpeg（在 /opt/hermes/tools）。部署机连 GitHub 极慢、连不上 Playwright 的
# CDN，所以构建前先由 scripts/base_seed.py 把这些大文件按 sha256 从 hermes 的公开镜像、npmmirror 备好（GitHub 只剩
# s6-overlay 三个小包），再用它生成的 Dockerfile 副本（多两行 COPY）构建；构建本身只再连 PyPI、npm、Debian 源。
cmd_base() {
    if [ "$NO_PULL" = 0 ]; then
        cmd_pull
        local pass="--no-pull"
        if [ -n "$BRANCH_OPT" ]; then pass="$pass --branch $BRANCH_OPT"; fi
        if [ "$YES" = 1 ]; then pass="$pass --yes"; fi
        # shellcheck disable=SC2086
        exec bash "$SCRIPT" base $pass
    fi
    build_base
    if [ "$BASE_IMAGE" != "$(base_tag)" ]; then
        warn "entry.env 里固定了 MT_DEPLOY_BASE_IMAGE=$BASE_IMAGE，沙箱镜像会继续用它；要用刚建的，删掉 entry.env 里那一行"
    else
        ok "沙箱镜像会用它：接着跑 ./deploy.sh all"
    fi
}

# 构建当前 hermes 源码指纹的基础镜像（本机已有就跳过），再核对 UniWork 内置技能的标记。base 和 all 共用。
build_base() {
    need docker; need git; need python3; need curl
    local tag log free_g seed
    tag="$(base_tag)"
    say "基础镜像：$tag（代码 $(head_short)；指纹只算 hermes 源码，不含前端 / 部署 / 文档 / 测试）"
    if docker image inspect "$tag" >/dev/null 2>&1; then
        ok "本机已有 $tag，不用重建"
    else
        free_g="$(df -BG --output=avail / | tail -1 | tr -dc 0-9)"
        [ "${free_g:-0}" -ge 20 ] || warn "根分区只剩 ${free_g}G，构建过程要十几 G"
        seed="$(cfg MT_DEPLOY_SEED_DIR /var/cache/hermes-mt/base-seed)"
        say "预置构建要下载的大文件到 $seed（已备好且 sha256 对得上的不重下）"
        python3 "$HERE/scripts/base_seed.py" "$REPO" "$seed" || die "预置文件没备齐，看上面的输出"
        log="$HERE/.base-build.log"
        warn "构建还要从 PyPI、npm、Debian 源下载依赖，约 15~45 分钟；完整输出在 $log"
        # 只把步骤行打到屏幕上，免得几十分钟没动静；成败看镜像在不在。
        (cd "$REPO" && BUILDX_BUILDER=default docker build --progress=plain -f "$seed/Dockerfile" \
            --build-context "seed=$seed" --build-arg S6_OVERLAY_BASE_URL=file:///tmp/s6-seed -t "$tag" . 2>&1) \
            | tee "$log" | grep --line-buffered -E '^#[0-9]+ \[[^]]+\] (RUN|COPY|FROM)|ERROR' | cut -c1-110 | sed 's/^/  /' || true
        docker image inspect "$tag" >/dev/null 2>&1 || die "基础镜像没建成，看 $log 末尾"
        ok "已构建 $tag"
    fi
    docker run --rm --network none --entrypoint test "$tag" -f /opt/hermes/skills/UNIWORK_BUNDLED_ONLY \
        && ok "镜像里有 UniWork 内置技能的标记" \
        || die "镜像里没有 /opt/hermes/skills/UNIWORK_BUNDLED_ONLY：这个提交不是带 UniWork 技能的版本"
}

# all：当前指纹的基础镜像不在本机就先建。entry.env 里用 MT_DEPLOY_BASE_IMAGE 固定的不自动建（那是人指定的）。
ensure_base() {
    if docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
        ok "基础镜像 $BASE_IMAGE 在本机，不用建"
        return 0
    fi
    [ "$BASE_IMAGE" = "$(base_tag)" ] \
        || die "entry.env 固定的基础镜像 $BASE_IMAGE 不在本机（MT_DEPLOY_BASE_IMAGE 固定的不会自动构建）"
    build_base
}

# ---------------------------------------------------------------- frontend

# all / up：前端产物不在、或不是当前代码构建的，就先重新构建（5~10 分钟）。成败看产物里的指纹。
ensure_frontend() {
    local want log
    want="$(frontend_want)"
    if [ -s "$HERE/nginx/dist-browser/index.html" ] && [ "$(frontend_have)" = "$want" ]; then
        ok "前端产物是当前代码构建的（指纹 $want），不用重建"
        return 0
    fi
    log="$HERE/.frontend-build.log"
    say "构建前端（指纹 $want）：产物不在或不是当前代码构建的，约 5~10 分钟；完整输出在 $log"
    # 只把关键行打到屏幕上，免得满屏 vite 输出。
    bash "$HERE/scripts/build-frontend.sh" 2>&1 | tee "$log" \
        | grep --line-buffered -iE 'added [0-9]+ packages|built in|前端已就位|npm (err|error)|error during build' \
        | sed 's/^/  /' || true
    [ -s "$HERE/nginx/dist-browser/index.html" ] && [ "$(frontend_have)" = "$want" ] \
        || die "前端没建成，看 $log 末尾"
    ok "前端产物 $(frontend_files) 个文件（指纹 $want）"
}

# ---------------------------------------------------------------- image

cmd_image() {
    local fp
    fp="$(fingerprint)"
    say "沙箱镜像：指纹 $fp（Dockerfile.cube + seed/* + overlay.list 列的仓库文件 + 基础镜像 + 模板参数）"
    cd "$HERE"
    check_overlay
    stage_overlay
    BUILDX_BUILDER=default docker build -f Dockerfile.cube --build-arg "BASE_IMAGE=$BASE_IMAGE" -t "$IMAGE_NAME:$fp" . 2>&1 | tail -n 4 | sed 's/^/  /'
    ok "已构建 $IMAGE_NAME:$fp"
    # 镜像里的转发器必须和仓库里的逐字节相同——这是「入口和模板一起升级」能成立的前提。
    local in_img in_repo
    in_img="$(docker run --rm --network none --entrypoint sha256sum "$IMAGE_NAME:$fp" /opt/mt/forward.py /opt/mt/mtstate.py /opt/mt/mtuser.py | awk '{print $1}' | tr '\n' ' ')"
    in_repo="$(sha256sum seed/forward.py seed/mtstate.py seed/mtuser.py | awk '{print $1}' | tr '\n' ' ')"
    [ "$in_img" = "$in_repo" ] && ok "镜像里的转发器与仓库一致" || die "镜像里的 forward.py/mtstate.py/mtuser.py 与仓库不一致"
    # 只发 UniWork 内置技能靠 hermes 自己的标记文件（见 README「技能」）：基础镜像太旧就没有，上游那套会露出来。
    docker run --rm --network none --entrypoint test "$IMAGE_NAME:$fp" -f /opt/hermes/skills/UNIWORK_BUNDLED_ONLY \
        && ok "镜像里的 hermes 只发 UniWork 内置技能" \
        || die "镜像里没有 /opt/hermes/skills/UNIWORK_BUNDLED_ONLY：基础镜像太旧，要用本仓库构建的（见 README「技能」）"
    # 覆盖进 /opt/hermes 的仓库文件同理，开一个容器一次比完。清单为空就不比（sha256sum 没参数会去读标准输入）。
    local files
    files="$(overlay_files | tr '\n' ' ')"
    if [ -n "${files// /}" ]; then
        # shellcheck disable=SC2086,SC2016
        in_img="$(docker run --rm --network none --entrypoint sh "$IMAGE_NAME:$fp" -c 'cd /opt/hermes && sha256sum "$@"' sh $files | awk '{print $1}' | tr '\n' ' ')"
        # shellcheck disable=SC2086
        in_repo="$(cd "$REPO" && sha256sum $files | awk '{print $1}' | tr '\n' ' ')"
        [ "$in_img" = "$in_repo" ] || die "镜像里 /opt/hermes 下的覆盖文件与仓库不一致（overlay.list）"
        ok "镜像里覆盖的 $(overlay_files | wc -l | tr -d ' ') 个仓库文件与仓库一致"
    else
        ok "没有覆盖进 /opt/hermes 的仓库文件（overlay.list 为空）"
    fi

    if registry_has_tag "$fp"; then
        ok "仓库 $REGISTRY 已有 $REPO_PATH:$fp，跳过推送"
    else
        push_image "$fp"
    fi
    printf '%s' "$fp" > "$HERE/.image-fingerprint"
}

# 部署机的 Docker 只信任 127.0.0.0/8 为不安全仓库、又不能改 daemon 配置，所以起一个只听
# 127.0.0.1 的临时转发，把推送落进集群仓库；退出钩子保证转发关掉、临时标签删掉。
push_image() {
    local fp="$1" host port
    host="${REGISTRY%%:*}"; port="${REGISTRY##*:}"
    say "推送到 $REGISTRY（经 127.0.0.1:$FWD_PORT 临时转发）"
    ss -lnt | grep -qE ":${FWD_PORT}[[:space:]]" && die "端口 $FWD_PORT 被占"
    python3 - "$FWD_PORT" "$host" "$port" <<'PY' &
import socket, sys, threading
lport, rhost, rport = int(sys.argv[1]), sys.argv[2], int(sys.argv[3])
def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d: break
            b.sendall(d)
    except OSError: pass
    finally:
        for s in (a, b):
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", lport)); srv.listen(64)
while True:
    c, _ = srv.accept()
    try:
        u = socket.create_connection((rhost, rport), timeout=10); u.settimeout(None)
    except OSError:
        c.close(); continue
    threading.Thread(target=pipe, args=(c, u), daemon=True).start()
    threading.Thread(target=pipe, args=(u, c), daemon=True).start()
PY
    FWD_PID=$!
    FWD_REF="127.0.0.1:$FWD_PORT/$REPO_PATH:$fp"
    sleep 1
    [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$FWD_PORT/v2/")" = 200 ] || die "临时转发自检失败"
    docker tag "$IMAGE_NAME:$fp" "$FWD_REF"
    docker push "$FWD_REF" | tail -1
    cleanup
    registry_has_tag "$fp" && ok "仓库里已有 $REPO_PATH:$fp" || die "推送后仓库里查不到标签"
}

# ---------------------------------------------------------------- template

# 删一个模板，等平台删完（sync=true）：节点上的副本（根盘、快照）、根盘包、元数据一起清掉。
# 204 删掉了、404 本来就没有都算成功；删不掉时把平台给的原因打出来。
# 平台自己会拒绝删「还有运行中实例在用」的模板，但认不出暂停中的实例（Cube v0.7.1 的 isTemplateInUse
# 只认节点上报的实例，暂停的实例那一行不带模板 ID），所以调用方要先用入口自己的记录排除掉还在用的。
# 模板的构建任务还没结束时平台也回 409（build job is still active）：这种等任务结束再删，最多等 2 分钟。
delete_template() {
    local id="$1" out code
    for _ in $(seq 1 12); do
        out="$(curl -sS -m 300 -w '\n%{http_code}' -X DELETE "$CUBE_API/templates/$id?sync=true" 2>&1 || true)"
        code="${out##*$'\n'}"
        case "$code" in
            204|404) return 0 ;;
        esac
        case "$code:$out" in
            409:*"build job is still active"*) sleep 10 ;;
            *) break ;;
        esac
    done
    printf '    %s 删不掉（HTTP %s）：%s\n' "$id" "$code" "$(printf '%s' "${out%$'\n'*}" | tr '\n' ' ' | cut -c1-240)"
    return 1
}

# 建一个模板并等它的构建任务结束，模板 ID 放进 NEW_TPL。返回 0 = READY；1 = 建完了但有节点失败（或整体失败）；
# 2 = 十分钟还没建完。
# ★别拿副本的 status 判断：平台给节点建副本时先把它记成 status=FAILED，进度写在 phase 里（DISTRIBUTING、
# SNAPSHOTTING……做完才是 READY；phase=FAILED 才是真失败，带 error_message），同一个构建任务里还会重试失败的
# 节点（Cube 源码 templatecenter/store.go、distribution.go）。10-13 晚只看 status，把还在建的节点判成失败，
# 删不掉（409）又马上重建，连建四次，其实第三、四次都建成了。所以：构建任务结束（GET /templates/<ID>/builds/
# <jobID>/status 不再是 building）、而且没有副本还在建，才下结论；读不到任务状态时只看 phase。
build_template() {
    local fp="$1" last="" s created job
    created="$(api POST /templates -d "{
      \"name\": \"hermes-mt-$fp\",
      \"image\": \"http://$REGISTRY/$REPO_PATH:$fp\",
      \"cpu\": $TPL_CPU, \"memory\": $TPL_MEM, \"writableLayerSize\": \"$TPL_DISK\",
      \"exposedPorts\": [9121, 49983], \"probePort\": 9121, \"probePath\": \"/__mt/health\",
      \"allowInternetAccess\": true
    }" | py 'import json,sys; d=json.load(sys.stdin); print(d.get("templateID") or "", d.get("jobID") or ""); sys.stderr.write("  " + json.dumps(d)[:200] + "\n")')"
    NEW_TPL="${created%% *}"
    NEW_JOB="${created#* }"
    [ -n "$NEW_TPL" ] || die "建模板失败"
    for _ in $(seq 1 120); do
        job=""
        [ -n "$NEW_JOB" ] && job="$(api GET "/templates/$NEW_TPL/builds/$NEW_JOB/status" 2>/dev/null | py '
import json,sys
try: print(json.load(sys.stdin).get("status") or "")
except Exception: print("")' 2>/dev/null || true)"
        s="$(api GET "/templates/$NEW_TPL" 2>/dev/null | py '
import json,sys
job = sys.argv[1]
try: d = json.load(sys.stdin)
except Exception: print("BUILDING 读不到模板状态"); raise SystemExit
replicas = d.get("replicas") or []
phase = lambda r: str(r.get("phase") or r.get("status") or "?").upper()
failed = [r for r in replicas if phase(r) == "FAILED"]
building = not replicas or any(phase(r) not in ("READY", "FAILED") for r in replicas)
settled = job == "error" or (job != "building" and not building)
nodes = " ".join("%s:%s" % (r.get("node_ip") or "?", phase(r)) for r in replicas)
if not settled:
    print("BUILDING", nodes or d.get("status") or "")
elif d.get("status") == "READY" and not failed:
    print("READY", nodes)
else:
    why = (failed[0].get("error_message") if failed else "") or d.get("lastError") or d.get("status") or ""
    print("FAILED_ON", ",".join(r.get("node_ip") or "?" for r in failed) or "-", " ".join(str(why).split())[:160])' "$job")"
        [ "$s" != "$last" ] && { printf '  %s %s\n' "$(date +%T)" "$s"; last="$s"; }
        case "$s" in
            READY*) return 0 ;;
            FAILED*) return 1 ;;
        esac
        sleep 5
    done
    return 2
}

cmd_template() {
    local fp tpl
    fp="$(fingerprint)"
    registry_has_tag "$fp" || die "仓库里没有 $REPO_PATH:$fp，先跑 ./deploy.sh image"
    say "模板：镜像 $REPO_PATH:$fp"
    tpl="$(template_for_tag "$fp")"
    if [ -n "$tpl" ]; then
        ok "集群上已有这个镜像的模板 $tpl，复用"
    else
        # 平台建模板偶发失败：某个节点做根盘时 mke2fs 报错，换节点出现，同一个镜像重建就好（10-09、10-12、10-13）。
        # 所以有节点失败就重建一个，第一次之外最多再试 TPL_RETRIES 次。失败的模板从没被用过、没起过实例，当场删掉；
        # 删不掉的列出来交给平台的同事。
        local attempt=0 rc left=""
        while :; do
            attempt=$((attempt + 1))
            [ "$attempt" -gt 1 ] && warn "第 $attempt 次建模板：上一次有节点失败（平台偶发），重建一个"
            rc=0
            build_template "$fp" || rc=$?
            [ "$rc" = 0 ] && break
            [ "$rc" = 2 ] && die "模板 $NEW_TPL 十分钟内没 READY（还在建，没有节点失败）；过一会儿再跑 ./deploy.sh template"
            if delete_template "$NEW_TPL"; then ok "失败的模板 $NEW_TPL 已删掉"; else left="${left:+$left }$NEW_TPL"; fi
            [ "$attempt" -gt "$TPL_RETRIES" ] && die "建了 $attempt 次模板都有节点失败，停下${left:+。没删掉的失败模板：$left（交给平台的同事）}"
        done
        tpl="$NEW_TPL"
        ok "模板 $tpl READY（可写层 $TPL_DISK）"
        [ -z "$left" ] || warn "没删掉的失败模板：$left（交给平台的同事）"
    fi
    if [ "$TEMPLATE" != "$tpl" ]; then
        set_cfg MT_CUBE_TEMPLATE "$tpl"
        ok "entry.env: MT_CUBE_TEMPLATE ${TEMPLATE:-（空）} -> $tpl"
        TEMPLATE="$tpl"
    else
        ok "entry.env 里已是 $tpl"
    fi
    grep -qE '^MT_CUBE_VOLUME_MOUNT=' "$ENV_FILE" || set_cfg MT_CUBE_VOLUME_MOUNT /mnt/u
}

# ---------------------------------------------------------------- up

cmd_up() {
    say "起容器"
    ensure_override
    [ -n "$TEMPLATE" ] || die "entry.env 里 MT_CUBE_TEMPLATE 为空，先跑 ./deploy.sh template"
    # nginx 镜像在下面 up --build 时把 nginx/dist-browser/ 拷进去：先保证它是当前代码构建的。
    ensure_frontend
    chmod 600 "$ENV_FILE"

    local foreign_before entry_before
    foreign_before="$(foreign_containers)"
    entry_before="$(docker inspect -f '{{.Id}}' "$PROJECT-entry" 2>/dev/null || true)"
    cd "$HERE"
    # 数据库只在没起来时才碰：compose 判断项目配置变了会把它一起重建，升级入口不该重启 PG。
    if [ "$(docker inspect -f '{{.State.Running}}' "$PROJECT-postgres" 2>/dev/null || true)" != true ]; then
        compose up -d --quiet-pull postgres 2>&1 | sed 's/^/  /' | tail -n 4
        ok "postgres 已启动"
    else
        ok "postgres 在跑，不动它"
    fi
    compose up -d --build --quiet-pull --no-deps entry nginx 2>&1 | sed 's/^/  /' | tail -n 12
    local entry_after
    entry_after="$(docker inspect -f '{{.Id}}' "$PROJECT-entry" 2>/dev/null || true)"
    if [ "$entry_after" != "$entry_before" ]; then
        # nginx 启动时把入口地址解析死了，入口容器一换就 502，必须跟着重启一次。
        compose restart nginx >/dev/null 2>&1
        ok "入口已重建，nginx 已跟着重启"
    else
        ok "入口容器没变"
    fi

    local st
    for _ in $(seq 1 40); do
        st="$(docker inspect -f '{{.State.Health.Status}}' "$PROJECT-entry" 2>/dev/null || true)"
        [ "$st" = healthy ] && break
        sleep 3
    done
    [ "$st" = healthy ] && ok "入口 healthy" || die "入口 120s 内没 healthy：docker logs $PROJECT-entry"
    docker exec "$PROJECT-nginx" wget -q -O /dev/null -T 5 http://entry:9400/hermes/__entry/health && ok "nginx -> 入口 通" || die "nginx 连不到入口"
    [ "$(docker logs --since 3m "$PROJECT-entry" 2>&1 | grep -cE 'Traceback|ERROR')" = 0 ] && ok "入口日志没有报错" || warn "入口日志有报错：docker logs $PROJECT-entry"
    [ "$(docker inspect -f '{{json .Mounts}}' "$PROJECT-entry")" = "[]" ] && ok "入口没有挂载 docker.sock" || warn "入口有挂载：$(docker inspect -f '{{json .Mounts}}' "$PROJECT-entry")"
    [ "$(foreign_containers)" = "$foreign_before" ] && ok "别人的容器仍是 $foreign_before 个" || die "别人的容器数变了（$foreign_before -> $(foreign_containers)），马上查"
    printf '%s  commit=%s  image=%s  template=%s\n' "$(date '+%F %T')" "$(head_short)" "$(cat "$HERE/.image-fingerprint" 2>/dev/null || echo -)" "$TEMPLATE" >> "$HISTORY"
}

# ---------------------------------------------------------------- status / purge

cmd_set() {
    [ $# -gt 0 ] || die "用法：./deploy.sh set KEY=VALUE [KEY=VALUE…]（只认 MT_ 开头的键）"
    local item key value
    for item in "$@"; do
        case "$item" in
            MT_[A-Z0-9_]*=*) ;;
            *) die "不认识的写法：$item（要 MT_XXX=值）" ;;
        esac
        key="${item%%=*}"; value="${item#*=}"
        set_cfg "$key" "$value"
        case "$key" in
            *KEY*|*SECRET*|*PASSWORD*|*TOKEN*) ok "$key 已写入（值不显示）" ;;
            *) ok "$key=$value 已写入" ;;
        esac
    done
    say "入口要重新加载才生效：./deploy.sh up"
}

# 实例里每 5 分钟一次的定时归档：PG 里的「最近归档」只记入口经手的那几次（暂停、删实例前），
# 这里经数据面问每台实例的 /__mt/status。只问运行中的实例：数据面请求会把暂停的实例叫醒。
# 限制了公开访问的实例要流量令牌（PG 里加密存着），这里问不到，显示「问不到」。
instance_archives() {
    local domain sid state slug
    domain="$(cfg MT_CUBE_DOMAIN cube.app)"
    echo "  实例里的定时归档（只问运行中的；用户 实例 阶段 最近归档时间 归档 可写层）："
    our_sandboxes | while read -r sid state _ _ slug; do
        [ "$state" = running ] || continue
        curl -sS -m 8 -H "Host: 9121-${sid}.${domain}" "$CUBE_PROXY/__mt/status" 2>/dev/null | py '
import json, sys, time
try:
    s = json.load(sys.stdin).get("state") or {}
except Exception:
    print("问不到"); sys.exit()
at = s.get("last_archive_at")
when = time.strftime("%m-%d %H:%M:%S", time.localtime(at)) if isinstance(at, (int, float)) and at else "-"
used = (s.get("writable_layer") or {}).get("used_pct", "?")
print(s.get("phase") or "-", when, s.get("last_archive") or "-", "已用%s%%" % used)' | sed "s/^/    ${slug:-?} ${sid:0:12} /"
    done
}

cmd_status() {
    say "现状"
    printf '  代码 %s  模板 %s  镜像指纹 %s\n' "$(head_short)" "${TEMPLATE:-（空）}" "$(cat "$HERE/.image-fingerprint" 2>/dev/null || echo -)"
    local backup_state="未配置"
    [ -n "$(cfg MT_BACKUP_S3_ENDPOINT)" ] && [ -n "$(cfg MT_BACKUP_S3_ACCESS_KEY)" ] && backup_state="已配置"
    printf '  开关：空闲删实例 %sh  限制公开访问 %s  PG锁 %s  卷外副本 %s\n' \
        "$(cfg MT_IDLE_DELETE_HOURS 0)" "$(cfg MT_CUBE_PRIVATE_TRAFFIC 0)" "$(cfg MT_PG_LOCK 1)" "$backup_state"
    docker ps -a --format '  {{.Names}}  {{.Status}}' | grep "$PROJECT-" || true
    echo "  租户（PG：用户 状态 实例 模板 编号 最近归档 下次定时任务）："
    # 下次定时任务经 to_jsonb 取：入口还没跑过迁移 006 时这一列不存在，直接写列名整条查询会失败。
    docker exec "$PROJECT-postgres" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "  " -c "SELECT left(user_id,10), state, left(sandbox_id,12), template_id, state_epoch, state_archive, COALESCE(to_jsonb(r)->>\$\$next_cron_at\$\$, \$\$-\$\$) FROM tenant_runtime r ORDER BY last_activity_at DESC"' 2>/dev/null | sed 's/^/    /' || echo "    （PG 没起来）"
    echo "  集群上我们的实例（ID 状态 模板 节点 用户）："
    our_sandboxes | sed 's/^/    /' || echo "    （控制面不可达）"
    instance_archives
    echo "  集群上我们的模板："
    api GET /templates 2>/dev/null | py 'import json,sys
try: items = json.load(sys.stdin)
except Exception: items = []
for t in items:
    if "hermes-mt" in (t.get("imageInfo") or ""): print("   ", t["templateID"], t.get("status"), (t.get("imageInfo") or "")[-80:])' || true
    if [ -f "$HISTORY" ]; then echo "  部署记录："; tail -3 "$HISTORY" | sed 's/^/    /'; fi
}

cmd_purge_old() {
    [ -n "$TEMPLATE" ] || die "entry.env 里没有模板"
    say "不在模板 $TEMPLATE 上的实例"
    local list
    list="$(our_sandboxes | awk -v t="$TEMPLATE" '$3 != t')"
    [ -n "$list" ] || { ok "没有，不用删"; return 0; }
    printf '%s\n' "$list" | sed 's/^/  /'
    echo "  说明：新入口会在用户下次请求时自动排空并重建这些实例；只有旧转发器（没有排空接口）"
    echo "  的实例才需要手工删，它们可写层上的对话历史会丢。"
    confirm "  确定删除以上实例？" || { echo "  没删"; return 0; }
    printf '%s\n' "$list" | while read -r id _; do
        printf '  %s ' "$id"; curl -s -o /dev/null -w 'DELETE -> HTTP %{http_code}\n' -X DELETE -m 120 "$CUBE_API/sandboxes/$id"
    done
    sleep 3
    ok "剩余：$(our_sandboxes | awk -v t="$TEMPLATE" '$3 != t' | wc -l) 台不在当前模板上"
}

# ---------------------------------------------------------------- purge-templates

# 集群上我们的模板（镜像来自 hermes-mt），每行：模板ID 状态。控制面不可达时返回非 0。
our_templates() {
    api GET /templates 2>/dev/null | py '
import json,sys
try: items = json.load(sys.stdin)
except Exception: sys.exit(3)
for t in items:
    if "hermes-mt" in (t.get("imageInfo") or ""):
        print(t["templateID"], t.get("status"))'
}

# 入口记着的、还挂着实例的模板（运行中和暂停的都算）。平台认不出暂停的实例，这份是兜底。
tenant_templates() {
    docker exec "$PROJECT-postgres" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT DISTINCT template_id FROM tenant_runtime WHERE sandbox_id IS NOT NULL AND template_id IS NOT NULL"'
}

# 集群上所有实例用的模板（不只是我们的），一行一个；看不出模板的（多半是暂停中的）记为 -。
cluster_sandbox_templates() {
    api GET /sandboxes 2>/dev/null | py '
import json,sys
try: items = json.load(sys.stdin)
except Exception: sys.exit(3)
for s in items:
    print(s.get("templateID") or "-")'
}

# 删掉我们不再用的模板，腾出各节点的磁盘：保留当前和上一版（回退用），还有实例在用的不删，其余列出来确认后删。
# --api 指另一个集群的控制面（例如搬走以后的老集群）：入口没接它，「当前 / 上一版」不适用，只按有没有实例判断。
cmd_purge_templates() {
    local api_url="" keep="" prev="" list sbx in_use unknown t status todo="" done_n=0 fail_n=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --api) api_url="${2:-}"; shift 2 ;;
            *) die "purge-templates 只认 --api <控制面地址>" ;;
        esac
    done
    if [ -n "$api_url" ] && [ "$api_url" != "$CUBE_API" ]; then
        CUBE_API="$api_url"
        say "清理 $CUBE_API 上我们的模板（入口没接这个集群，不分当前 / 上一版）"
    else
        say "清理 $CUBE_API 上我们的模板"
        [ -f "$HISTORY" ] && prev="$(sed -n 's/.*template=\(tpl-[0-9a-z]*\).*/\1/p' "$HISTORY" | awk -v cur="$TEMPLATE" '$0 != cur' | tail -1)"
        keep="$TEMPLATE $prev"
        ok "保留当前 ${TEMPLATE:-（无）}、上一版 ${prev:-（无）}"
    fi
    list="$(our_templates)" || die "控制面 $CUBE_API 列不出模板"
    [ -n "$list" ] || { ok "集群上没有我们的模板"; return 0; }
    in_use="$(tenant_templates)" || die "读不到入口数据库：不知道哪些模板还有用户的实例（暂停的平台认不出），不敢删"
    sbx="$(cluster_sandbox_templates)" || die "控制面列不出实例，不敢删"
    unknown="$(printf '%s\n' "$sbx" | grep -cx -- '-' || true)"
    [ "$unknown" = 0 ] || warn "集群上有 $unknown 台实例看不出用的哪个模板（多半是暂停中的）；我们用户的实例以入口数据库为准"
    in_use="$in_use
$sbx"
    echo "  我们的模板："
    while read -r t status; do
        if printf '%s\n' $keep | grep -qx -- "$t"; then
            printf '    %-32s %-16s 保留\n' "$t" "$status"
        elif printf '%s\n' "$in_use" | grep -qx -- "$t"; then
            printf '    %-32s %-16s 还有实例在用，不删\n' "$t" "$status"
        else
            printf '    %-32s %-16s 删\n' "$t" "$status"
            todo="${todo:+$todo }$t"
        fi
    done <<< "$list"
    [ -n "$todo" ] || { ok "没有可删的"; return 0; }
    confirm "  确定删除标「删」的模板？（只删模板，用户的卷和归档不受影响）" || { echo "  没删"; return 0; }
    for t in $todo; do
        if delete_template "$t"; then printf '    %s 已删\n' "$t"; done_n=$((done_n + 1)); else fail_n=$((fail_n + 1)); fi
    done
    if [ "$fail_n" = 0 ]; then ok "删掉 $done_n 个"; else warn "删掉 $done_n 个，$fail_n 个删不掉（原因见上，交给平台的同事）"; fi
}

# ---------------------------------------------------------------- all

# all 开头先说这次要做哪些耗时的步骤。沙箱镜像叠在基础镜像上：基础镜像一换，沙箱镜像也整个重建。
plan() {
    local base front cube="按内容指纹，没变就跳过"
    if docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
        base="已有，跳过"
    else
        base="要构建，15~45 分钟"
        cube="跟着基础镜像整个重建，20~40 分钟"
    fi
    if frontend_current; then front="是当前代码构建的，跳过"; else front="要重新构建，5~10 分钟"; fi
    say "这次要做：基础镜像 $base；前端 $front；沙箱镜像和模板 $cube"
}

cmd_all() {
    if [ "$NO_PULL" = 0 ]; then
        cmd_pull
        # 代码换了，脚本自己也可能换了：用新的那份接着跑。
        local pass="--no-pull"
        if [ -n "$BRANCH_OPT" ]; then pass="$pass --branch $BRANCH_OPT"; fi
        if [ "$YES" = 1 ]; then pass="$pass --yes"; fi
        # shellcheck disable=SC2086
        exec bash "$SCRIPT" all $pass
    fi
    plan
    ensure_base
    ensure_frontend
    cmd_check
    cmd_image
    cmd_template
    cmd_up
    say "摘要"
    printf '  代码 %s  镜像 %s:%s  模板 %s  页面 http://%s/hermes/\n' \
        "$(head_short)" "$IMAGE_NAME" "$(cat "$HERE/.image-fingerprint")" "$TEMPLATE" "$HTTP_PORT"
    local stale
    stale="$(our_sandboxes | awk -v t="$TEMPLATE" '$3 != t' | wc -l)"
    if [ "$stale" != 0 ]; then
        echo "  有 $stale 台实例还在旧模板上：新入口会在用户下次请求时自动排空、重建、恢复；"
        echo "  若它们的转发器太旧（没有排空接口），用 ./deploy.sh purge-old 手工删。"
    fi
    echo "  验收：浏览器登录 → 发一句话 → 拖一个文件；5 分钟后 ./deploy.sh status 看 state_archive 有值。"
}

# ---------------------------------------------------------------- 后台跑、前台看

# 耗时、会改东西的命令（几分钟到一小时）。
long_running() { case "$1" in all|base|image|template|up) return 0 ;; *) return 1 ;; esac; }

# 正在跑的那次部署的进程号：登记过、进程也还在；没有就空（进程没了的登记当它不存在）。
running_pid() {
    local pid
    pid="$(sed -n 1p "$RUNNING" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then printf '%s' "$pid"; fi
    return 0
}

# 真正开跑前登记「正在跑」。同一时间只许一次部署：两次同时跑会抢着构建、改 entry.env。
# 日志：后台跑的是 .deploy-logs/ 里那份；在前台跑、输出又重定向到文件的（nohup … > 文件），记那个文件。
register_run() {
    local pid log
    pid="$(running_pid)"
    if [ -n "$pid" ] && [ "$pid" != "$$" ]; then
        die "已有一次部署在跑（$(sed -n 2p "$RUNNING")，进程 $pid），等它跑完；看进度：./deploy.sh log"
    fi
    log="${MT_DEPLOY_LOG:-$(readlink -f "/proc/$$/fd/1" 2>/dev/null || true)}"
    [ -f "$log" ] || log=""
    printf '%s\n%s\n%s\n' "$$" "$1，$(date '+%m-%d %H:%M') 开始" "$log" > "$RUNNING"
}

# 在终端里敲耗时的命令：真正的部署放到后台单独的会话里跑（终端断开、Ctrl+C 都碰不到它），
# 前台实时跟它的日志，它结束前台也结束，退出码一样。已经有一次在跑就不再起，直接跟那一次。
run_detached() {
    local cmd="$1" log
    shift
    if [ -n "$(running_pid)" ]; then
        warn "已有一次部署在跑（$(sed -n 2p "$RUNNING")），不再起第二次；下面接着看它的进度"
        follow_run
    fi
    mkdir -p "$LOG_DIR"
    log="$LOG_DIR/$cmd-$(date +%Y%m%d-%H%M%S).log"
    ln -sfn "$(basename "$log")" "$LOG_DIR/latest.log"
    rm -f "$LAST_EXIT"
    if command -v setsid >/dev/null 2>&1; then
        MT_DEPLOY_DETACHED=1 MT_DEPLOY_LOG="$log" setsid bash "$SCRIPT" "$cmd" "$@" > "$log" 2>&1 < /dev/null &
    else
        MT_DEPLOY_DETACHED=1 MT_DEPLOY_LOG="$log" nohup bash "$SCRIPT" "$cmd" "$@" > "$log" 2>&1 < /dev/null &
    fi
    # 等它自己登记（setsid 可能再分叉一次，$! 不一定是它的进程号）。
    for _ in $(seq 1 50); do
        [ -n "$(running_pid)" ] && break
        sleep 0.2
    done
    if [ -z "$(running_pid)" ] && [ ! -s "$LAST_EXIT" ]; then
        cat "$log" 2>/dev/null || true
        die "部署没起来，看 $log"
    fi
    say "部署在后台跑，下面是实时进度（日志 $log）。Ctrl+C、终端断开都只是不看了，部署照样跑完；接着看：./deploy.sh log"
    follow_run "$log"
}

# follow_run [日志]：跟正在跑的那次部署直到它结束（刚跑完、没来得及跟的，把日志整个打出来），
# 再报结果；退出码和那次部署的一样。
follow_run() {
    local pid log
    pid="$(running_pid)"
    log="${1:-$(sed -n 3p "$RUNNING" 2>/dev/null || true)}"
    if [ -n "$pid" ] && [ -n "$log" ] && [ -f "$log" ]; then
        trap 'printf "\n"; warn "只是不看了，部署还在后台跑；接着看：./deploy.sh log"; exit 0' INT
        tail -n +1 -f --pid="$pid" "$log" || true
        trap - INT
    elif [ -n "$pid" ]; then
        warn "这次部署的输出没有落到文件里（$(sed -n 2p "$RUNNING")），只能等它结束"
        while kill -0 "$pid" 2>/dev/null; do sleep 2; done
    elif [ -n "$log" ] && [ -f "$log" ]; then
        cat "$log"
    fi
    report_last "${log:-$(readlink -f "$LOG_DIR/latest.log" 2>/dev/null || true)}"
}

# 报上一次部署的结果，按它的退出码退出。
report_last() {
    local rc
    rc="$(cat "$LAST_EXIT" 2>/dev/null || true)"
    case "$rc" in
        0) ok "部署跑完了（日志 $1）" ;;
        '') rc=1; printf '  \033[31m[停止]\033[0m %s\n' "部署进程没了，也没留下结果（可能被强行结束或机器重启过）；看日志 $1" >&2 ;;
        *) printf '  \033[31m[停止]\033[0m %s\n' "部署中途停了（退出码 $rc），原因看上面最后几行；日志 $1" >&2 ;;
    esac
    exit "$rc"
}

# ./deploy.sh log：在跑就接着实时看；没在跑就打出上一次的最后 40 行和结果。
cmd_log() {
    if [ -n "$(running_pid)" ]; then
        follow_run
    fi
    local log
    log="$(readlink -f "$LOG_DIR/latest.log" 2>/dev/null || true)"
    [ -n "$log" ] && [ -f "$log" ] || die "$LOG_DIR 里还没有日志：在终端里敲 ./deploy.sh all 才会留"
    tail -n 40 "$log"
    report_last "$log"
}

# ---------------------------------------------------------------- main

main() {
    local cmd="${1:-}"; shift || true
    local args=("$@") rest=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --yes) YES=1; shift ;;
            --no-pull) NO_PULL=1; shift ;;
            --branch) BRANCH_OPT="$2"; shift 2 ;;
            *) rest="$rest $1"; shift ;;
        esac
    done
    # shellcheck disable=SC2086
    case "$cmd" in
        init) cmd_init $rest ;;
        log) cmd_log ;;
        all|base|check|image|template|up|status|purge-old|purge-templates|pull|set)
            if long_running "$cmd"; then
                # 在终端里敲的：后台跑、前台实时看（run_detached 不会返回）。输出已经重定向到别处、
                # 或者这本身就是后台那一份，就照常往下跑。部署机的 bash 4.2 在 set -u 下展开空数组会报错。
                if [ -z "${MT_DEPLOY_DETACHED:-}" ] && [ -t 1 ]; then
                    run_detached "$cmd" ${args[@]+"${args[@]}"}
                fi
                register_run "$cmd"
            fi
            load_cfg
            case "$cmd" in
                all) cmd_all ;;
                base) cmd_base ;;
                check) cmd_check ;;
                image) cmd_image ;;
                template) cmd_template ;;
                up) cmd_up ;;
                status) cmd_status ;;
                purge-old) cmd_purge_old ;;
                purge-templates) cmd_purge_templates $rest ;;
                pull) cmd_pull ;;
                set) cmd_set $rest ;;
            esac ;;
        *) sed -n '2,20p' "$SCRIPT"; exit 1 ;;
    esac
}

main "$@"
