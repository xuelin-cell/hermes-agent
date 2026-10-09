#!/usr/bin/env bash
# 多租户栈的一键部署 / 升级脚本。在部署机上以 root 运行，工作目录随意。
#
#   ./deploy.sh all            拉代码 → 只读检查 → 沙箱镜像(按需) → 模板(按需) → 写配置 → 起容器 → 验收
#   ./deploy.sh check          只读摸底，不改任何东西
#   ./deploy.sh image          构建沙箱镜像并推到集群仓库（内容没变就跳过推送）
#   ./deploy.sh template       确保集群上有当前镜像的模板，把模板 ID 写进 entry.env
#   ./deploy.sh up             启动 / 更新三个容器（入口重建后自动重启 nginx）
#   ./deploy.sh status         看现状：容器、PG 里的租户、集群上的实例和模板
#   ./deploy.sh purge-old      删掉不在当前模板上的实例（会问确认；只有旧转发器的实例才需要）
#   ./deploy.sh set KEY=VALUE… 改 entry.env 里的一项或几项（只认 MT_ 开头），然后提示你跑 up 生效
#   ./deploy.sh init --http-port IP:端口 --cube-api URL --cube-proxy URL [--registry HOST:PORT]
#                              首次部署：生成 entry.env（密钥现场随机、600）和 compose.override.yaml
#   选项：--no-pull（all 时不拉代码）  --branch 名字  --yes（不问确认）
#
# 为什么要有这个脚本：手册里的每一步都有能出错的细节（构建器、不安全仓库、模板要和入口一起换、
# 入口重建后 nginx 要重启、entry.env 权限……），漏一条就是线上事故。这里把它们全部变成
# 检查项和自动步骤，人只需要跑一条命令、看一份摘要。
#
# 沙箱镜像按「内容指纹」命名，不按提交号：指纹 = Dockerfile.cube + seed/* + 基础镜像 ID + 模板参数。
# 只改入口代码时镜像和模板一个都不会重做；改了转发器就一定重做。入口发现实例的模板和配置里的
# 不一致，会在用户下次请求时自动排空、删除、重建、恢复（见 seed/mtstate.py），不用手工删实例。
#
# 部署机上的硬规矩（共享生产机）：不重启 Docker、不改 daemon 配置、不 prune、不切换默认构建器
# （每条构建命令前加 BUILDX_BUILDER=default）、页面只绑内网 IP、compose 永远带 --env-file、
# 不打印任何密钥。本脚本只做这些之内的事。
#
# 配置全部从 entry.env 读。除入口自己的变量外，部署专用的几项（都有默认值）：
#   MT_DEPLOY_REGISTRY      集群镜像仓库 HOST:PORT，默认 = MT_CUBE_API 的主机 + :5000
#   MT_DEPLOY_BASE_IMAGE    沙箱镜像的基础镜像，默认 hermes-custom:a2007f2（必须已在本机）
#   MT_DEPLOY_TPL_CPU/MEM   模板规格，默认 2000 / 2000（毫核 / MiB）
#   MT_DEPLOY_TPL_DISK      模板可写层，默认 8G
#   MT_DEPLOY_BRANCH        all 时拉哪个分支，默认当前分支
#   MT_DEPLOY_FWD_PORT      推镜像用的本机临时转发端口，默认 15000
#   MT_DEPLOY_FRONTEND_SRC  前端产物目录为空时从这里复制（例如 /mnt/hermes-runtime/hermes）

set -euo pipefail

SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
HERE="$(cd "$(dirname "$SCRIPT")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ENV_FILE="$HERE/entry.env"
OVERRIDE="$HERE/compose.override.yaml"
HISTORY="$HERE/.deploy-history"
PROJECT=hermes-mt
IMAGE_NAME=hermes-mt-cube
REPO_PATH=hermes-mt/hermes-mt-cube

YES=0
NO_PULL=0
BRANCH_OPT=""
FWD_PID=""
FWD_REF=""

# 推镜像时起的后台转发进程和临时标签：不管脚本怎么退出都要收掉。
cleanup() {
    if [ -n "$FWD_PID" ]; then kill "$FWD_PID" 2>/dev/null || true; FWD_PID=""; fi
    if [ -n "$FWD_REF" ]; then docker rmi "$FWD_REF" >/dev/null 2>&1 || true; FWD_REF=""; fi
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
    BASE_IMAGE="$(cfg MT_DEPLOY_BASE_IMAGE hermes-custom:a2007f2)"
    TPL_CPU="$(cfg MT_DEPLOY_TPL_CPU 2000)"
    TPL_MEM="$(cfg MT_DEPLOY_TPL_MEM 2000)"
    TPL_DISK="$(cfg MT_DEPLOY_TPL_DISK 8G)"
    FWD_PORT="$(cfg MT_DEPLOY_FWD_PORT 15000)"
    FRONTEND_SRC="$(cfg MT_DEPLOY_FRONTEND_SRC)"
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

# ---------------------------------------------------------------- 指纹

fingerprint() {
    local base_id
    base_id="$(docker image inspect --format '{{.Id}}' "$BASE_IMAGE" 2>/dev/null || true)"
    [ -n "$base_id" ] || die "基础镜像 $BASE_IMAGE 不在本机（MT_DEPLOY_BASE_IMAGE）"
    {
        cat "$HERE/Dockerfile.cube"
        # config.yaml.tmpl 由入口渲染后经引导接口送进实例，不在镜像里，改它不必换模板。
        for f in "$HERE"/seed/*; do
            [ -f "$f" ] || continue
            case "$f" in */config.yaml.tmpl) continue ;; esac
            printf 'seed/%s\n' "$(basename "$f")"; cat "$f"
        done
        printf 'base=%s\ntpl=%s/%s/%s\n' "$base_id" "$TPL_CPU" "$TPL_MEM" "$TPL_DISK"
    } | sha256sum | cut -c1-12
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
    local before after
    before="$(git rev-parse --short=7 HEAD)"
    git reset -q --hard FETCH_HEAD
    after="$(git rev-parse --short=7 HEAD)"
    ok "HEAD: $before -> $after  $(git log -1 --format=%s | cut -c1-60)"
    if [ "$(grep -rlI $'\r' "$HERE" 2>/dev/null | grep -vc dist-browser || true)" != 0 ]; then
        die "部署目录里有带 CR 的文件（检出时行尾没保住），不能继续"
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

    docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 && ok "基础镜像 $BASE_IMAGE 在本机" || die "基础镜像 $BASE_IMAGE 不在本机"
    if [ -s "$HERE/nginx/dist-browser/index.html" ]; then
        ok "前端产物 $(find "$HERE/nginx/dist-browser" -type f | wc -l) 个文件"
    elif [ -n "$FRONTEND_SRC" ] && [ -s "$FRONTEND_SRC/index.html" ]; then
        warn "前端产物为空，起容器前会从 $FRONTEND_SRC 复制"
    else
        die "nginx/dist-browser 为空，且没有 MT_DEPLOY_FRONTEND_SRC 可复制（见 README「前置条件」）"
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

# ---------------------------------------------------------------- image

cmd_image() {
    local fp
    fp="$(fingerprint)"
    say "沙箱镜像：指纹 $fp（Dockerfile.cube + seed/* + 基础镜像 + 模板参数）"
    cd "$HERE"
    BUILDX_BUILDER=default docker build -f Dockerfile.cube --build-arg "BASE_IMAGE=$BASE_IMAGE" -t "$IMAGE_NAME:$fp" . 2>&1 | tail -n 4 | sed 's/^/  /'
    ok "已构建 $IMAGE_NAME:$fp"
    # 镜像里的转发器必须和仓库里的逐字节相同——这是「入口和模板一起升级」能成立的前提。
    local in_img in_repo
    in_img="$(docker run --rm --network none --entrypoint sha256sum "$IMAGE_NAME:$fp" /opt/mt/forward.py /opt/mt/mtstate.py | awk '{print $1}' | tr '\n' ' ')"
    in_repo="$(sha256sum seed/forward.py seed/mtstate.py | awk '{print $1}' | tr '\n' ' ')"
    [ "$in_img" = "$in_repo" ] && ok "镜像里的转发器与仓库一致" || die "镜像里的 forward.py/mtstate.py 与仓库不一致"

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

cmd_template() {
    local fp tpl
    fp="$(fingerprint)"
    registry_has_tag "$fp" || die "仓库里没有 $REPO_PATH:$fp，先跑 ./deploy.sh image"
    say "模板：镜像 $REPO_PATH:$fp"
    tpl="$(template_for_tag "$fp")"
    if [ -n "$tpl" ]; then
        ok "集群上已有这个镜像的模板 $tpl，复用"
    else
        tpl="$(api POST /templates -d "{
          \"name\": \"hermes-mt-$fp\",
          \"image\": \"http://$REGISTRY/$REPO_PATH:$fp\",
          \"cpu\": $TPL_CPU, \"memory\": $TPL_MEM, \"writableLayerSize\": \"$TPL_DISK\",
          \"exposedPorts\": [9121, 49983], \"probePort\": 9121, \"probePath\": \"/__mt/health\",
          \"allowInternetAccess\": true
        }" | py 'import json,sys; d=json.load(sys.stdin); print(d.get("templateID") or ""); sys.stderr.write("  " + json.dumps(d)[:200] + "\n")')"
        [ -n "$tpl" ] || die "建模板失败"
        local last="" s
        for _ in $(seq 1 120); do
            s="$(api GET "/templates/$tpl" | py 'import json,sys; d=json.load(sys.stdin); print(d.get("status"), (d.get("lastError") or "")[:200])')"
            [ "$s" != "$last" ] && { printf '  %s %s\n' "$(date +%T)" "$s"; last="$s"; }
            case "$s" in READY*) break ;; FAILED*) die "模板 $tpl 构建失败" ;; esac
            sleep 5
        done
        case "$last" in READY*) ok "模板 $tpl READY（可写层 $TPL_DISK）" ;; *) die "模板 $tpl 十分钟内没 READY" ;; esac
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
    if [ ! -s "$HERE/nginx/dist-browser/index.html" ]; then
        [ -n "$FRONTEND_SRC" ] && [ -s "$FRONTEND_SRC/index.html" ] || die "前端产物为空"
        mkdir -p "$HERE/nginx/dist-browser"
        cp -rL "$FRONTEND_SRC/." "$HERE/nginx/dist-browser/"
        ok "前端产物已从 $FRONTEND_SRC 复制（$(find "$HERE/nginx/dist-browser" -type f | wc -l) 个文件）"
    fi
    [ -n "$TEMPLATE" ] || die "entry.env 里 MT_CUBE_TEMPLATE 为空，先跑 ./deploy.sh template"
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

# ---------------------------------------------------------------- all

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

# ---------------------------------------------------------------- main

main() {
    local cmd="${1:-}"; shift || true
    local rest=""
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
        all|check|image|template|up|status|purge-old|pull|set)
            load_cfg
            case "$cmd" in
                all) cmd_all ;;
                check) cmd_check ;;
                image) cmd_image ;;
                template) cmd_template ;;
                up) cmd_up ;;
                status) cmd_status ;;
                purge-old) cmd_purge_old ;;
                pull) cmd_pull ;;
                set) cmd_set $rest ;;
            esac ;;
        *) sed -n '2,13p' "$SCRIPT"; exit 1 ;;
    esac
}

main "$@"
