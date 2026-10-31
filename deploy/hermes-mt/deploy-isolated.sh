#!/usr/bin/env bash
# 同机独立部署（Cube 后端），原 deploy.sh / compose.yaml 保持不变。
# 每套部署必须使用独立 checkout 和 entry.env。
# ./deploy-isolated.sh init --project hermes-adaptation --subnet 未占用CIDR --http-port 内网IP:18082 --cube-api URL --cube-proxy URL
# ./deploy-isolated.sh all [--no-pull] [--branch cloud-adaptation]
# ./deploy-isolated.sh config|check|base|image|template|up|status|log
# purge-old / purge-templates 永久拒绝；共用集群的旧部署也必须停用这两条命令。
set -euo pipefail

SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
HERE="$(cd "$(dirname "$SCRIPT")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ENV_FILE="$HERE/entry.env"
YES=0
NO_PULL=0
BRANCH_OPT=""
FWD_PID=""
FWD_REF=""

# 只加载函数，不执行旧入口。不复制千行构建逻辑；旧脚本入口结构变动时停止。
[ "$(tail -n 1 "$HERE/deploy.sh")" = 'main "$@"' ] || {
    echo 'deploy.sh 入口结构已变化，请更新独立部署脚本的函数加载逻辑' >&2; exit 1;
}
eval "$(sed -n '/^cleanup() /,$p' "$HERE/deploy.sh" | sed '$d' | sed 's|\./deploy\.sh|./deploy-isolated.sh|g')"
eval "$(declare -f load_cfg | sed '1s/load_cfg/legacy_load_cfg/')"
eval "$(declare -f build_template | sed 's/hermes-mt-\$fp/${PROJECT}-\$fp/g')"
eval "$(declare -f cmd_up | sed '1s/cmd_up/legacy_cmd_up/')"
# 旧检查针对 override 的 !reset；新 Compose 本身已经省略 socket 挂载。
eval "$(declare -f cmd_check | sed '/grep -q.*!reset.*OVERRIDE/c\
    ensure_override\
    ok "独立 Compose 不挂载 docker.sock"\
')"
eval "$(declare -f cmd_check | sed '1s/cmd_check/legacy_cmd_check/')"

PROJECT="$(cfg MT_DEPLOY_PROJECT)"
HISTORY="$HERE/.isolated-history"
LOG_DIR="$HERE/.isolated-logs"
RUNNING="$HERE/.isolated-running"
LAST_EXIT="$HERE/.isolated-last-exit"
OVERRIDE="$HERE/compose.isolated.yaml"
trap cleanup EXIT

set_cfg() {
    python3 - "$ENV_FILE" "$1" "$2" <<'PY'
import os, sys
from pathlib import Path
path, key, value = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
if "\n" in value or "\r" in value:
    raise SystemExit("配置值不能包含换行")
lines = path.read_text().splitlines()
lines = [line for line in lines if not line.startswith(key + "=")]
lines.append(key + "=" + value)
os.chmod(path, 0o600)
path.write_text("\n".join(lines) + "\n")
PY
}

validate_project() {
    printf '%s' "$PROJECT" | grep -qE '^[a-z][a-z0-9-]{2,47}$' || die '项目名需为 3–48 位小写字母、数字或连字符，以字母开头'
    [ "$PROJECT" != hermes-mt ] || die '不能使用旧部署的项目名 hermes-mt'
    case "$PROJECT" in *hermes-mt*) die '项目名不能包含 hermes-mt，避免被旧模板清理逻辑认领' ;; esac
}

load_cfg() {
    PROJECT="$(cfg MT_DEPLOY_PROJECT)"
    validate_project
    legacy_load_cfg
    [ "$BACKEND" = cube ] || die '独立部署只支持 MT_BACKEND=cube'
    [ -n "$(cfg MT_PREFIX)" ] && [ "$(cfg MT_PREFIX)" != hermes-mt ] && [ "$(cfg MT_PREFIX)" != hermes ] \
        || die '请设置独立 MT_PREFIX；迁移原数据时保留 .116 原前缀'
    [ -n "$(cfg MT_COOKIE)" ] && [ "$(cfg MT_COOKIE)" != hermes_mt_session ] \
        || die '请设置独立 MT_COOKIE，避免同一 IP 下登录态冲突'
    printf '%s' "$HTTP_PORT" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+$' \
        || die 'MT_HTTP_PORT 必须带内网 IP，例如 192.168.1.7:18082'
    FWD_PORT="$(cfg MT_DEPLOY_FWD_PORT 15001)"
    IMAGE_NAME="$PROJECT-cube"
    # 避开旧 purge-templates 对镜像名中 hermes-mt 的宽泛匹配。
    REPO_PATH="hermes-isolated/$PROJECT-cube"
    export MT_DEPLOY_PROJECT="$PROJECT"
}

compose() {
    check_network_subnet
    # 显式 -f，不加载旧 compose.override.yaml 或 COMPOSE_FILE。
    BUILDX_BUILDER=default MT_DEPLOY_PROJECT="$PROJECT" MT_HTTP_PORT="$HTTP_PORT" MT_DOCKER_SUBNET="$(cfg MT_DOCKER_SUBNET)" \
        docker compose --project-directory "$HERE" --env-file "$ENV_FILE" \
        -f "$HERE/compose.isolated.yaml" -p "$PROJECT" "$@"
}

check_network_subnet() {
    python3 "$HERE/scripts/check-network-subnet.py" "$(cfg MT_DOCKER_SUBNET)" \
        "$HTTP_PORT" "$CUBE_API" "$CUBE_PROXY" "$REGISTRY" "$@"
}

cmd_check() {
    check_network_subnet --host-project "$PROJECT"
    legacy_cmd_check
}

cmd_up() {
    check_network_subnet --host-project "$PROJECT"
    legacy_cmd_up
}

ensure_override() {
    # 独立 Compose 本身不挂 docker.sock，也不发布 PG 端口。
    [ -f "$HERE/compose.isolated.yaml" ] || die '缺少 compose.isolated.yaml'
}

cmd_init() {
    local prefix="" http_port="" cube_api="" cube_proxy="" registry="" subnet=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --project) PROJECT="${2:?缺少项目名}"; shift 2 ;;
            --prefix) prefix="${2:?缺少用户卷前缀}"; shift 2 ;;
            --subnet) subnet="${2:?缺少独立子网}"; shift 2 ;;
            --http-port) http_port="${2:?缺少页面地址}"; shift 2 ;;
            --cube-api) cube_api="${2:?缺少控制面地址}"; shift 2 ;;
            --cube-proxy) cube_proxy="${2:?缺少数据面地址}"; shift 2 ;;
            --registry) registry="${2:?缺少仓库地址}"; shift 2 ;;
            *) die "init 不认识的参数 $1" ;;
        esac
    done
    validate_project
    [ -n "$cube_api" ] && [ -n "$cube_proxy" ] || die 'init 需要 --cube-api 和 --cube-proxy'
    printf '%s' "$http_port" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+$' || die '--http-port 必须为内网 IP:端口'
    prefix="${prefix:-$PROJECT}"
    printf '%s' "$prefix" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9_-]*$' || die '无效的用户卷前缀'
    [ "$prefix" != hermes-mt ] && [ "$prefix" != hermes ] || die '不能复用 .7 旧部署的用户卷前缀'
    python3 "$HERE/scripts/check-network-subnet.py" "$subnet" "$http_port" "$cube_api" "$cube_proxy" "$registry"
    [ ! -e "$ENV_FILE" ] || die 'entry.env 已存在，不覆盖'
    python3 - "$ENV_FILE" "$PROJECT" "$prefix" "$http_port" "$cube_api" "$cube_proxy" "$registry" "$(g rev-parse --abbrev-ref HEAD)" "$subnet" <<'PY'
import base64, os, secrets, sys
path, project, prefix, http, api, proxy, registry, branch, subnet = sys.argv[1:]
password = secrets.token_hex(16)
values = dict(
    MT_DEPLOY_PROJECT=project, MT_PREFIX=prefix, MT_DOCKER_SUBNET=subnet,
    MT_COOKIE=project.replace("-", "_") + "_session",
    MT_HTTP_PORT=http, MT_BACKEND="cube", MT_CUBE_API=api, MT_CUBE_PROXY=proxy,
    MT_CUBE_DOMAIN="cube.app", MT_CUBE_TEMPLATE="", MT_CUBE_VOLUME_MOUNT="/mnt/u",
    MT_POSTGRES_DB="hermes_entry", MT_POSTGRES_USER="hermes_entry", MT_POSTGRES_PASSWORD=password,
    MT_DATABASE_URL="postgresql://hermes_entry:" + password + "@postgres:5432/hermes_entry",
    MT_CREDENTIAL_KEY=base64.urlsafe_b64encode(secrets.token_bytes(32)).decode(),
    MT_DEPLOY_FWD_PORT="15001", MT_DEPLOY_BRANCH=branch,
    MT_BACKUP_PREFIX="backups/" + project + "/", MT_DEV_LOGIN="0", MT_COOKIE_SECURE="0",
    MT_TZ="Asia/Shanghai", MT_IDLE_MINUTES="30", MT_IDLE_DELETE_HOURS="0",
    PIP_INDEX_URL="https://mirrors.aliyun.com/pypi/simple/",
)
if registry:
    values["MT_DEPLOY_REGISTRY"] = registry
if any(any(c in v for c in "\n\r'$# ") for v in values.values()):
    raise SystemExit("配置值不能包含换行、空格或 dotenv 插值字符")
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    # 与原脚本 cfg() 的无引号格式保持一致。
    stream.write("".join(k + "=" + v + "\n" for k, v in values.items()))
PY
    ok '独立配置已生成；数据库不发布宿主机端口。迁移旧数据请使用原数据库和原加密密钥。'
}

our_sandboxes() {
    # 不凭通用 metadata 认领其他部署的实例；只显示本入口数据库登记的 ID。
    local ids
    ids="$(docker exec "$PROJECT-postgres" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT sandbox_id FROM tenant_runtime WHERE sandbox_id IS NOT NULL"')" \
        || die '无法读取本部署实例归属，停止查询'
    api GET /sandboxes | python3 -c '
import json, sys
owned = set(sys.argv[1].splitlines())
for s in json.load(sys.stdin):
    if s["sandboxID"] in owned:
        m = s.get("metadata") or {}
        print(s["sandboxID"], s.get("state"), s.get("templateID"), s.get("clientID"), (m.get("hermes.mt.slug") or "")[:10])
' "$ids"
}

cmd_status() {
    say "独立部署 $PROJECT"
    compose ps
    echo '  本部署数据库登记的实例（ID 状态 模板 节点 用户）：'
    our_sandboxes
    instance_archives
    echo '  本部署仓库路径下的模板：'
    api GET /templates | python3 -c '
import json, sys
for t in json.load(sys.stdin):
    if ("/" + sys.argv[1] + ":") in (t.get("imageInfo") or ""):
        print("   ", t["templateID"], t.get("status"))
' "$REPO_PATH"
}

cmd_purge_old() { die '共享集群禁用 purge-old；请按本部署数据库记录逐台处理'; }
cmd_purge_templates() { die '共享集群禁用 purge-templates'; }

case "${1:-}" in
    purge-old|purge-templates) die '共享集群禁用批量清理，不会调用旧脚本的清理命令' ;;
    init) ;;
    config) load_cfg; compose config --quiet; exit ;;
    set|log) load_cfg ;;
    all|base|check|image|template|up|status|pull)
        load_cfg; check_network_subnet ;;
    *) sed -n '2,7p' "$SCRIPT"; exit 1 ;;
esac
main "$@"
