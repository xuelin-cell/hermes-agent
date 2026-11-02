#!/usr/bin/env bash
# 同机独立部署（Cube 后端），原 deploy.sh / compose.yaml 保持不变。
# 每套部署必须使用独立 checkout 和 entry.env。
# ./deploy-isolated.sh init --project hermes-adaptation --subnet 未占用CIDR --http-port 内网IP:18082 --cube-api URL --cube-proxy URL
# ./deploy-isolated.sh all [--no-pull] [--branch cloud-adaptation]
# ./deploy-isolated.sh config|check|base|image|template|up|status|log|purge-templates [--branch BRANCH]
# purge-old 永久拒绝；模板自动清理只认项目和分支专属镜像路径。
# 旧命名模板需显式指定：purge-templates --branch BRANCH --legacy-template tpl-ID
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
    BRANCH_SLUG="$(python3 - "$BRANCH" <<'PY'
import hashlib, re, sys
branch = sys.argv[1]
slug = re.sub(r"[^a-z0-9]+", "-", branch.lower()).strip("-")[:48].strip("-") or "branch"
print(slug + "-" + hashlib.sha256(branch.encode()).hexdigest()[:12])
PY
)"
    # Each branch gets a separate registry repository. Template cleanup can then
    # prove ownership from Cube's imageInfo without guessing from a display name.
    REPO_PATH="hermes-isolated/$PROJECT/$BRANCH_SLUG-cube"
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
    say "独立部署 $PROJECT（分支 $BRANCH）"
    compose ps
    echo '  本部署数据库登记的实例（ID 状态 模板 节点 用户）：'
    our_sandboxes
    instance_archives
    echo "  本部署分支的模板（$REPO_PATH）："
    api GET /templates | python3 -c '
import json, sys
for t in json.load(sys.stdin):
    if ("/" + sys.argv[1] + ":") in (t.get("imageInfo") or ""):
        print("   ", t["templateID"], t.get("status"))
' "$REPO_PATH"
}

cmd_purge_old() { die '共享集群禁用 purge-old；请按本部署数据库记录逐台处理'; }

branch_templates() {
    api GET /templates | python3 -c '
import json, re, sys
from pathlib import Path
repo, history, project, branch = sys.argv[1:5]
requested = set(sys.argv[5:])
try:
    items = json.load(sys.stdin)
except Exception:
    sys.exit(3)
records = {}
if requested:
    path = Path(history)
    if not path.is_file():
        sys.exit("找不到本机部署历史，拒绝清理旧命名模板")
    for line in path.read_text().splitlines():
        fields = dict(re.findall(r"(?:^|\s)(branch|template|image)=([^\s]+)", line))
        records.setdefault(fields.get("template", ""), []).append(fields)
by_id = {str(t.get("templateID") or ""): t for t in items}
for template_id in sorted(requested):
    template = by_id.get(template_id)
    rows = records.get(template_id, [])
    if template is None or not rows:
        sys.exit("旧模板不在集群或本机部署历史中：" + template_id)
    if any(r.get("branch") and r["branch"] != branch for r in rows):
        sys.exit("部署历史将旧模板记录为其他分支，拒绝清理：" + template_id)
    image = str(template.get("imageInfo") or "")
    legacy = "/hermes-isolated/" + project + "-cube:"
    tag = image.split(legacy, 1)[1].split("@", 1)[0] if legacy in image else ""
    if not tag or not any(r.get("image") == tag for r in rows):
        sys.exit("旧模板的项目镜像路径或镜像指纹与部署历史不符：" + template_id)
needle = "/" + repo + ":"
for template in items:
    image = str(template.get("imageInfo") or "")
    if needle in image or template.get("templateID") in requested:
        print(template.get("templateID", ""), template.get("status", ""), sep="\t")
' "$REPO_PATH" "$HISTORY" "$PROJECT" "$BRANCH" "$@"
}

branch_previous_template() {
    python3 - "$HISTORY" "$BRANCH" "$TEMPLATE" <<'PY'
import re, sys
from pathlib import Path
path, branch, current = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
if not path.is_file():
    raise SystemExit
previous = ""
for line in path.read_text(errors="replace").splitlines():
    fields = dict(re.findall(r"(?:^|\s)(branch|template)=([^\s]+)", line))
    template = fields.get("template", "")
    if fields.get("branch") == branch and template and template != current:
        previous = template
print(previous)
PY
}

cmd_up() {
    legacy_cmd_up
    # Legacy cmd_up writes the normal deployment receipt. Tag its final row with
    # the branch so a later cleanup on this checkout keeps only this branch's rollback.
    python3 - "$HISTORY" "$BRANCH" <<'PY'
import sys
from pathlib import Path
path, branch = Path(sys.argv[1]), sys.argv[2]
lines = path.read_text().splitlines()
if lines and " branch=" not in lines[-1]:
    lines[-1] += " branch=" + branch
    path.write_text("\n".join(lines) + "\n")
PY
}

cmd_purge_templates() {
    local legacy_ids=""
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --legacy-template)
                [ "$#" -ge 2 ] && [[ "$2" =~ ^tpl-[a-z0-9]+$ ]] || die '--legacy-template 需要合法模板 ID'
                legacy_ids="${legacy_ids:+$legacy_ids }$2"
                shift 2 ;;
            *) die 'purge-templates 只接受 --branch BRANCH 和可重复的 --legacy-template tpl-ID' ;;
        esac
    done
    local current="$TEMPLATE" previous list in_use sandboxes unknown t status keep todo="" done_n=0 fail_n=0
    previous="$(branch_previous_template)"
    say "清理项目 $PROJECT 的分支 $BRANCH 模板"
    ok "分支模板镜像仓库为 $REPO_PATH"
    ok "保留当前 ${current:-（无）}、本分支上一版 ${previous:-（无）}"

    [ -z "$legacy_ids" ] || warn "旧记录没有可靠的分支标识，仅核对明确指定的旧模板：$legacy_ids"
    # IDs have been restricted to tpl-[a-z0-9]+ above.
    # shellcheck disable=SC2086
    list="$(branch_templates $legacy_ids)" || die '模板查询或旧模板归属校验失败；没有删除任何模板'
    [ -n "$list" ] || { ok '本项目本分支没有可清理的模板'; return 0; }
    in_use="$(tenant_templates)" || die '读不到本部署数据库；没有删除任何模板'
    sandboxes="$(cluster_sandbox_templates)" || die '控制面无法列出集群实例；没有删除任何模板'
    unknown="$(printf '%s\n' "$sandboxes" | awk '$0 == "-" { n++ } END { print n+0 }')"
    [ "$unknown" = 0 ] || die "集群有 $unknown 台实例的模板 ID 不可识别；为避免误删，本次不删除任何模板"
    keep="$(printf '%s\n%s\n' "$current" "$previous")"
    echo '  本项目本分支模板及明确指定的旧模板：'
    while IFS="$(printf '\t')" read -r t status; do
        [ -n "$t" ] || continue
        if grep -qxF -- "$t" <<< "$keep"; then
            printf '    %-32s %-16s 保留（当前或回退）\n' "$t" "$status"
        elif grep -qxF -- "$t" <<< "$in_use" || grep -qxF -- "$t" <<< "$sandboxes"; then
            printf '    %-32s %-16s 保留（仍有实例使用）\n' "$t" "$status"
        else
            printf '    %-32s %-16s 可删\n' "$t" "$status"
            todo="${todo:+$todo }$t"
        fi
    done <<< "$list"
    [ -n "$todo" ] || { ok '没有可删的模板'; return 0; }
    confirm '  确定删除以上标记为可删的模板？' || { echo '  没删'; return 0; }
    for t in $todo; do
        # Refresh cluster references immediately before each deletion. Other deployments
        # may create instances while this command is waiting for confirmation.
        in_use="$(tenant_templates)" || die '重新读取本部署实例失败；已停止后续删除'
        sandboxes="$(cluster_sandbox_templates)" || die '重新读取集群实例失败；已停止后续删除'
        unknown="$(printf '%s\n' "$sandboxes" | awk '$0 == "-" { n++ } END { print n+0 }')"
        [ "$unknown" = 0 ] || die "出现 $unknown 台模板 ID 不可识别的实例；已停止后续删除"
        if grep -qxF -- "$t" <<< "$sandboxes" || grep -qxF -- "$t" <<< "$in_use"; then
            printf '    %s 保留（确认时已有实例使用）\n' "$t"
            continue
        fi
        if delete_template "$t"; then printf '    %s 已删\n' "$t"; done_n=$((done_n + 1)); else fail_n=$((fail_n + 1)); fi
    done
    if [ "$fail_n" = 0 ]; then ok "删掉 $done_n 个"; else warn "删掉 $done_n 个，$fail_n 个删不掉（原因见上）"; fi
}

case "${1:-}" in
    purge-old) die '共享集群禁用 purge-old，不会调用旧脚本的清理命令' ;;
    purge-templates) ;;
    init) ;;
    config) load_cfg; compose config --quiet; exit ;;
    set|log) load_cfg ;;
    all|base|check|image|template|up|status|pull)
        load_cfg; check_network_subnet ;;
    *) sed -n '2,7p' "$SCRIPT"; exit 1 ;;
esac
main "$@"
