#!/usr/bin/env bash
# 多租户验收：两个用户各自的世界互不可见、容器之间网络不可达。
# 需要入口开 MT_DEV_LOGIN=1（不走短信）。在宿主上跑，需要 curl + docker。
#   BASE=http://localhost:18081 bash scripts/verify_isolation.sh
#   （Windows Git Bash 上前面加 MSYS_NO_PATHCONV=1，否则 docker exec 里的 /var/run 路径会被改写）
#
# ★ 这个文件的第一原则：**一条不可能失败的反向断言比没有断言更糟**。
#   旧版第 4 段是 `if docker exec … curl …; then bad; else ok; fi`——容器没在跑、
#   名字打错、daemon 报错，退出码都是非 0，于是一律报「围栏生效 PASS」。
#   所以这里所有反向断言都走 check_blocked：探针必须**证明自己跑过**（回显 RC=n），
#   并且必须有一条**正向对照**跑通同一条路上除被测环节之外的全部环节。
#   对照不通 = 这条断言什么也证明不了 = 记 BROKEN，不记 PASS。
set -u
set -o pipefail

BASE="${BASE:-http://localhost:18081}"
PREFIX="${MT_PREFIX:-hermes}"
A="${USER_A:-alice}"; B="${USER_B:-bob}"
ENTRY_C="${MT_ENTRY_CONTAINER:-hermes-mt-entry}"
PG_C="${MT_PG_CONTAINER:-hermes-mt-postgres}"
PG_NET="${MT_PLATFORM_NET:-hermes-mt}"
# 临时目录用相对路径：Windows Git Bash 下配合 MSYS_NO_PATHCONV=1 跑时 curl.exe 也认
TMP="$(mktemp -d ./.verify.XXXXXX)"; trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; broke=0
ok()     { echo "PASS    $1"; pass=$((pass+1)); }
bad()    { echo "FAIL    $1"; fail=$((fail+1)); }
broken() { echo "BROKEN  $1"; broke=$((broke+1)); }
check()  { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# ---- 容器内探针 ---------------------------------------------------------------
# 一律用 python3 而不是 curl：租户镜像里 python3 一定在（转发器就是它跑的），
# 而「容器里恰好没装 curl」会让 curl 探针永远失败，又变成一条假绿的反向断言。
# 输出约定：跑到了就回显一行 RC=<数字>；**没有输出就代表探针根本没跑起来**。
exec_py() { # $1=容器 $2=python 源码
  docker exec "$1" python3 -c "$2" 2>/dev/null
}

tcp_probe() { # $1=容器 $2=目标IP $3=端口 -> RC=0 通 / RC=1 不通 / 空 探针没跑
  exec_py "$1" "
import socket
s = socket.socket(); s.settimeout(3)
try:
    s.connect(('$2', $3)); print('RC=0')
except Exception:
    print('RC=1')
finally:
    s.close()
"
}

http_probe() { # $1=容器 $2=URL [$3=Host 头] -> RC=<http状态> / RC=1 连不上 / 空 探针没跑
  exec_py "$1" "
import urllib.request, urllib.error
req = urllib.request.Request('$2')
h = '${3:-}'
if h:
    req.add_header('Host', h)
try:
    print('RC=%d' % urllib.request.urlopen(req, timeout=3).getcode())
except urllib.error.HTTPError as e:
    print('RC=%d' % e.code)
except Exception:
    print('RC=1')
"
}

# ★ 反向断言的唯一正确形状：探针必须失败，**并且**对照必须成功。
check_blocked() { # $1=标签 $2=探针输出 $3=对照输出
  case "$2" in
    RC=*) ;;
    *) broken "$1 —— 探针没跑起来（docker exec 无输出），这条断言证明不了任何事"; return;;
  esac
  case "$3" in
    RC=0|RC=200) ;;
    RC=*) broken "$1 —— 正向对照不通（$3），说明是链路坏了不是围栏生效"; return;;
    *) broken "$1 —— 正向对照没跑起来"; return;;
  esac
  case "$2" in
    RC=0|RC=200) bad "$1 —— 居然通了（$2）";;
    *) ok "$1（探针 $2，对照 $3）";;
  esac
}

login() { # $1=user $2=jar
  curl -s -c "$2" -H 'Content-Type: application/json' -d "{\"user\":\"$1\"}" "$BASE/hermes/__entry/dev-login" -o "$TMP/login.$1.json" -w '%{http_code}'
}
wait_backend() { # $1=jar ; 触发容器拉起，最多等 200s
  for _ in $(seq 1 40); do
    body="$(curl -s -b "$1" --max-time 30 "$BASE/hermes/__hermes_backend/api/health" 2>/dev/null)"
    case "$body" in *'"ok":true'*) return 0;; esac
    sleep 5
  done
  return 1
}
ws_probe() { # $1=jar ; 输出握手状态 + 首帧
  curl -s -i -N --max-time 8 -b "$1" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: $BASE" \
    "$BASE/hermes/api/ws" 2>/dev/null | tr -d '\0' | head -c 4000
}
files_json() { # $1=jar
  curl -s -b "$1" "$BASE/hermes/__hermes_backend/api/files"
}
read_code() { # $1=jar $2=path
  curl -s -o /dev/null -w '%{http_code}' -b "$1" \
    "$BASE/hermes/__hermes_backend/api/files/read?path=$2"
}

echo "== 0. 未登录访问静态 → 302 登录页"
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/hermes/")"
check "GET /hermes/ 未登录 -> $code" '[ "$code" = "302" ]'

echo "== 1. 用户 $A 登录并拉起容器"
code="$(login "$A" "$TMP/a.jar")"; check "dev-login $A -> $code" '[ "$code" = "200" ]'
code="$(curl -s -o /dev/null -w '%{http_code}' -b "$TMP/a.jar" "$BASE/hermes/")"; check "GET /hermes/ 已登录 -> $code" '[ "$code" = "200" ]'
check "$A 后端 health 通过入口可达" 'wait_backend "$TMP/a.jar"'
out="$(ws_probe "$TMP/a.jar")"
# 锚到状态行：旧版 grep " 101 " 在响应体里蒙到同样的三个字符就算过
check "$A ws 握手 101" 'printf "%s" "$out" | grep -qE "^HTTP/1\.[01] 101"'
check "$A 收到 gateway.ready" 'printf "%s" "$out" | grep -q "gateway.ready"'

echo "== 2. 用户 $B 登录并拉起容器"
code="$(login "$B" "$TMP/b.jar")"; check "dev-login $B -> $code" '[ "$code" = "200" ]'
check "$B 后端 health 通过入口可达" 'wait_backend "$TMP/b.jar"'
out="$(ws_probe "$TMP/b.jar")"
check "$B ws 握手 101" 'printf "%s" "$out" | grep -qE "^HTTP/1\.[01] 101"'

echo "== 3. 两个容器、两个卷、两个网络"
# 只认这次测的两个用户：机器上可能还有别人的租户在跑（浏览器开着、别的测试），
# 拿总数当判据会误报。
for u in "$A" "$B"; do
  st="$(docker inspect "$PREFIX-t-$u" --format '{{.State.Status}}' 2>/dev/null || echo missing)"
  check "$u 的容器在运行 (实际 $st)" '[ "$st" = "running" ]'
  # 容器名是 tenant_slug(user_id) 拼的。本段用裸用户名，只有在 slug==用户名时才成立，
  # 所以顺带核一下标签，避免「名字凑巧对上了但对应的是别人」。
  lbl="$(docker inspect "$PREFIX-t-$u" --format '{{index .Config.Labels "hermes.mt.user"}}' 2>/dev/null || echo missing)"
  check "$u 的容器 hermes.mt.user 标签就是 $u (实际 $lbl)" '[ "$lbl" = "$u" ]'
  vol="$(docker volume inspect "$PREFIX-data-$u" --format '{{.Name}}' 2>/dev/null || echo missing)"
  check "$u 有自己的数据卷 ($vol)" '[ "$vol" = "$PREFIX-data-$u" ]'
  net="$(docker network inspect "$PREFIX-net-$u" --format '{{.Name}}' 2>/dev/null || echo missing)"
  check "$u 有自己的网络 ($net)" '[ "$net" = "$PREFIX-net-$u" ]'
done
docker ps --filter label=hermes.mt=tenant --format '        {{.Names}}  {{.Status}}'

echo "== 4. 网络围栏（每条反向断言都带正向对照）"
ca="$PREFIX-t-$A"; cb="$PREFIX-t-$B"
ipa="$(docker inspect "$ca" --format "{{(index .NetworkSettings.Networks \"$PREFIX-net-$A\").IPAddress}}" 2>/dev/null || true)"
ipb="$(docker inspect "$cb" --format "{{(index .NetworkSettings.Networks \"$PREFIX-net-$B\").IPAddress}}" 2>/dev/null || true)"
ippg="$(docker inspect "$PG_C" --format "{{(index .NetworkSettings.Networks \"$PG_NET\").IPAddress}}" 2>/dev/null || true)"
check "拿到 $A 容器 IP ($ipa)" '[ -n "$ipa" ]'
check "拿到 $B 容器 IP ($ipb)" '[ -n "$ipb" ]'
check "拿到平台 PostgreSQL IP ($ippg)" '[ -n "$ippg" ]'

# 对照①：A 能连到**自己**的 9121 —— 证明 exec 通、python3 在、bridge 通、9121 真的在听。
self_a="$(tcp_probe "$ca" "$ipa" 9121)"
check "对照：$A 连得到自己的 9121（探针链路本身是好的，$self_a）" '[ "$self_a" = "RC=0" ]'
# 对照②：入口连得到 B 的 9121 —— 证明 B 的端口是活的，A 连不上不是因为 B 挂了。
entry_to_b="$(tcp_probe "$ENTRY_C" "$ipb" 9121)"

check_blocked "$A 容器连不到 $B 的 9121"  "$(tcp_probe "$ca" "$ipb" 9121)"  "$entry_to_b"
entry_to_a="$(tcp_probe "$ENTRY_C" "$ipa" 9121)"
check_blocked "$B 容器连不到 $A 的 9121"  "$(tcp_probe "$cb" "$ipa" 9121)"  "$entry_to_a"
# 租户够不到平台库：够得到就等于拿到全部用户的会话、凭据密文和审计
entry_to_pg="$(tcp_probe "$ENTRY_C" "$ippg" 5432)"
check_blocked "$A 容器连不到平台 PostgreSQL:5432" "$(tcp_probe "$ca" "$ippg" 5432)" "$entry_to_pg"

# 入口自己 connect 进了每个租户网络，所以租户反过来也够得到入口的控制面。
# 控制面上有 dev-login（开着就能给任意 user_id 签会话）、health（全量租户名单）、
# __hermes_backend 代理。hermes 跑的是用户的任意代码，这条必须堵死。
entry_ip_on_a="$(docker inspect "$ENTRY_C" --format "{{(index .NetworkSettings.Networks \"$PREFIX-net-$A\").IPAddress}}" 2>/dev/null || true)"
if [ -n "$entry_ip_on_a" ]; then
  # 对照必须证明「这条路由确实存在且回 200」，否则租户拿到 404 也会被当成围栏生效。
  cp_ctl="$(http_probe "$ENTRY_C" "http://127.0.0.1:9400/hermes/__entry/health")"
  cp_probe="$(http_probe "$ca" "http://$entry_ip_on_a:9400/hermes/__entry/health")"
  check_blocked "$A 容器够不到入口控制面 9400/__entry/health" "$cp_probe" "$cp_ctl"
else
  broken "入口没有接进 $PREFIX-net-$A，控制面这条没法判"
fi

check "$A 容器内自己的 hermes 正常" '[ "$(http_probe "$ca" "http://127.0.0.1:9120/api/health" "127.0.0.1:9120")" = "RC=200" ]'

# docker.sock：反向断言同样要能区分「文件不在」和「exec 没跑起来」
sock="$(exec_py "$ca" "
import os, stat
try:
    print('RC=0' if stat.S_ISSOCK(os.stat('/var/run/docker.sock').st_mode) else 'RC=1')
except OSError:
    print('RC=1')
")"
# 对照：同一个探针在同一个容器里看一个一定存在的路径，证明 exec+stat 是好的
sock_ctl="$(exec_py "$ca" "
import os, stat
try:
    print('RC=0' if stat.S_ISDIR(os.stat('/opt/data').st_mode) else 'RC=1')
except OSError:
    print('RC=1')
")"
check_blocked "$A 容器内看不到宿主 docker.sock" "$sock" "$sock_ctl"

echo "== 5. 文件链路与文件隔离（A、B 各传一个文件互为对照）"
printf 'secret-of-%s\n' "$A" > "$TMP/note-a.txt"
printf 'secret-of-%s\n' "$B" > "$TMP/note-b.txt"
upa="$(curl -s -b "$TMP/a.jar" -F "file=@$TMP/note-a.txt" -F "path=verify-a.txt" "$BASE/hermes/__hermes_backend/api/files/upload-stream" -o /dev/null -w '%{http_code}')"
upb="$(curl -s -b "$TMP/b.jar" -F "file=@$TMP/note-b.txt" -F "path=verify-b.txt" "$BASE/hermes/__hermes_backend/api/files/upload-stream" -o /dev/null -w '%{http_code}')"
check "$A 上传文件 -> $upa" '[ "$upa" = "200" ]'
check "$B 上传文件 -> $upb" '[ "$upb" = "200" ]'

ja="$(files_json "$TMP/a.jar")"; jb="$(files_json "$TMP/b.jar")"
check "$A 的文件根锁在 /opt/data/workspace" 'printf "%s" "$ja" | grep -q "\"locked_root\": *\"/opt/data/workspace\""'
check "$B 的文件根锁在 /opt/data/workspace" 'printf "%s" "$jb" | grep -q "\"locked_root\": *\"/opt/data/workspace\""'
# 正向对照：各自列得到自己的文件——列表接口确实返回了内容，
# 「列不到对方的」才有意义（旧版没有这一步，接口整个挂掉也会报 PASS）
check "$A 列得到自己的 verify-a.txt" 'printf "%s" "$ja" | grep -q "verify-a.txt"'
check "$B 列得到自己的 verify-b.txt" 'printf "%s" "$jb" | grep -q "verify-b.txt"'
if printf "%s" "$jb" | grep -q "verify-b.txt"; then
  if printf "%s" "$jb" | grep -q "verify-a.txt"; then bad "$B 列到了 $A 的文件（卷没隔离）"; else ok "$B 列不到 $A 的文件（各自的卷）"; fi
else
  broken "$B 列不到 $A 的文件 —— 对照不成立（$B 连自己的文件都没列到）"
fi

curl -s -b "$TMP/a.jar" "$BASE/hermes/__hermes_backend/api/files/download?path=verify-a.txt" -o "$TMP/back.txt"
check "$A 下载回来内容一致" 'cmp -s "$TMP/note-a.txt" "$TMP/back.txt"'

own="$(read_code "$TMP/b.jar" "verify-b.txt")"
other="$(read_code "$TMP/b.jar" "verify-a.txt")"
check "对照：$B 读得到自己的文件 -> $own（证明 /api/files/read 这条路是通的）" '[ "$own" = "200" ]'
if [ "$own" = "200" ]; then
  check "$B 读 $A 的文件名 -> $other (期望 404)" '[ "$other" = "404" ]'
else
  broken "$B 读 $A 的文件名 -> $other —— 对照不成立，404 可能只是这个接口整个不通"
fi
trav="$(read_code "$TMP/b.jar" "../.env")"
# 上游 _resolve_managed_path 对越界给的是 403「Path outside managed files root」，
# 不是随便一个 4xx：旧版 `${code#4}` 那种写法连「路由根本不存在的 404」都算过。
if [ "$own" = "200" ]; then
  # 400 和 403 都算真拒绝；404 不算——那说明路由压根不存在，证明不了鉴权做了事
  check "$B 路径穿越读 ../.env -> $trav (期望 400/403，不接受 404)" '[ "$trav" = "403" ] || [ "$trav" = "400" ]'
else
  broken "$B 路径穿越读 ../.env -> $trav —— 对照不成立"
fi

echo "== 6. 会话隔离：$A 的 cookie 拿不到 $B 的容器"
ua="$(curl -s -b "$TMP/a.jar" "$BASE/hermes/__entry/me" | tr -d ' ')"
ub="$(curl -s -b "$TMP/b.jar" "$BASE/hermes/__entry/me" | tr -d ' ')"
check "$A 的 /me 是 $A" 'printf "%s" "$ua" | grep -q "\"user_id\":\"$A\""'
check "$B 的 /me 是 $B" 'printf "%s" "$ub" | grep -q "\"user_id\":\"$B\""'
nocookie="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/hermes/__entry/me")"
check "无 cookie 的 /me -> $nocookie (期望 401)" '[ "$nocookie" = "401" ]'

echo
echo "PASS=$pass FAIL=$fail BROKEN=$broke"
echo "（BROKEN = 断言本身没跑成，既不算通过也不算失败；出现 BROKEN 说明这一轮的结论不可信）"
[ "$fail" = "0" ] && [ "$broke" = "0" ]
