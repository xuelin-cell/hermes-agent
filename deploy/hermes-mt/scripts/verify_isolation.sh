#!/usr/bin/env bash
# 多租户验收：两个用户各自的世界互不可见、容器之间网络不可达。
# 需要入口开 MT_DEV_LOGIN=1（不走短信）。在宿主上跑，需要 curl + docker。
#   BASE=http://localhost:18081 bash scripts/verify_isolation.sh
#   （Windows Git Bash 上前面加 MSYS_NO_PATHCONV=1，否则 docker exec 里的 /var/run 路径会被改写）
set -u
BASE="${BASE:-http://localhost:18081}"
PREFIX="${MT_PREFIX:-hermes}"
A="${USER_A:-alice}"; B="${USER_B:-bob}"
# 临时目录用相对路径：Windows Git Bash 下配合 MSYS_NO_PATHCONV=1 跑时 curl.exe 也认
TMP="$(mktemp -d ./.verify.XXXXXX)"; trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()   { echo "PASS  $1"; pass=$((pass+1)); }
bad()  { echo "FAIL  $1"; fail=$((fail+1)); }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

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

echo "== 0. 未登录访问静态 → 302 登录页"
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/hermes/")"
check "GET /hermes/ 未登录 -> $code" '[ "$code" = "302" ]'

echo "== 1. 用户 $A 登录并拉起容器"
code="$(login "$A" "$TMP/a.jar")"; check "dev-login $A -> $code" '[ "$code" = "200" ]'
code="$(curl -s -o /dev/null -w '%{http_code}' -b "$TMP/a.jar" "$BASE/hermes/")"; check "GET /hermes/ 已登录 -> $code" '[ "$code" = "200" ]'
check "$A 后端 health 通过入口可达" 'wait_backend "$TMP/a.jar"'
out="$(ws_probe "$TMP/a.jar")"
check "$A ws 握手 101" 'printf "%s" "$out" | grep -q " 101 "'
check "$A 收到 gateway.ready" 'printf "%s" "$out" | grep -q "gateway.ready"'

echo "== 2. 用户 $B 登录并拉起容器"
code="$(login "$B" "$TMP/b.jar")"; check "dev-login $B -> $code" '[ "$code" = "200" ]'
check "$B 后端 health 通过入口可达" 'wait_backend "$TMP/b.jar"'
out="$(ws_probe "$TMP/b.jar")"
check "$B ws 握手 101" 'printf "%s" "$out" | grep -q " 101 "'

echo "== 3. 两个容器、两个卷、两个网络"
# 只认这次测的两个用户：机器上可能还有别人的租户在跑（浏览器开着、别的测试），
# 拿总数当判据会误报。
for u in "$A" "$B"; do
  st="$(docker inspect "$PREFIX-t-$u" --format '{{.State.Status}}' 2>/dev/null || echo missing)"
  check "$u 的容器在运行 (实际 $st)" '[ "$st" = "running" ]'
  vol="$(docker volume inspect "$PREFIX-data-$u" --format '{{.Name}}' 2>/dev/null || echo missing)"
  check "$u 有自己的数据卷 ($vol)" '[ "$vol" = "$PREFIX-data-$u" ]'
  net="$(docker network inspect "$PREFIX-net-$u" --format '{{.Name}}' 2>/dev/null || echo missing)"
  check "$u 有自己的网络 ($net)" '[ "$net" = "$PREFIX-net-$u" ]'
done
docker ps --filter label=hermes.mt=tenant --format '      {{.Names}}  {{.Status}}'

echo "== 4. 网络围栏：$A 的容器够不到 $B 的容器"
ca="$PREFIX-t-$A"; cb="$PREFIX-t-$B"
ipb="$(docker inspect "$cb" --format "{{(index .NetworkSettings.Networks \"$PREFIX-net-$B\").IPAddress}}" 2>/dev/null)"
check "拿到 $B 容器 IP ($ipb)" '[ -n "$ipb" ]'
if docker exec "$ca" curl -s --max-time 3 -o /dev/null "http://$ipb:9121/api/health" 2>/dev/null; then
  bad "$A 容器能连到 $B 容器的 9121（不该可达）"
else
  ok "$A 容器连 $B 的 9121 失败（围栏生效）"
fi
check "$A 容器内自己的 hermes 正常" 'docker exec "$ca" curl -s --max-time 3 -H "Host: 127.0.0.1:9120" http://127.0.0.1:9120/api/health | grep -q "\"ok\":true"'
check "$A 容器内看不到宿主 docker.sock" '! docker exec "$ca" test -S /var/run/docker.sock'

echo "== 5. 文件链路与文件隔离"
note="$TMP/note.txt"; printf 'secret-of-%s
' "$A" > "$note"
up="$(curl -s -b "$TMP/a.jar" -F "file=@$note" -F "path=verify-note.txt" "$BASE/hermes/__hermes_backend/api/files/upload-stream" -w '
%{http_code}')"
check "$A 上传文件 -> $(printf '%s' "$up" | tail -1)" '[ "$(printf "%s" "$up" | tail -1)" = "200" ]'
check "$A 的文件根锁在 /opt/data/workspace" 'curl -s -b "$TMP/a.jar" "$BASE/hermes/__hermes_backend/api/files" | grep -q "\"locked_root\": *\"/opt/data/workspace\""'
check "$A 列得到刚传的文件" 'curl -s -b "$TMP/a.jar" "$BASE/hermes/__hermes_backend/api/files" | grep -q "verify-note.txt"'
curl -s -b "$TMP/a.jar" "$BASE/hermes/__hermes_backend/api/files/download?path=verify-note.txt" -o "$TMP/back.txt"
check "$A 下载回来内容一致" 'cmp -s "$note" "$TMP/back.txt"'
check "$B 列不到 $A 的文件（各自的卷）" '! curl -s -b "$TMP/b.jar" "$BASE/hermes/__hermes_backend/api/files" | grep -q "verify-note.txt"'
code="$(curl -s -o /dev/null -w '%{http_code}' -b "$TMP/b.jar" "$BASE/hermes/__hermes_backend/api/files/read?path=verify-note.txt")"
check "$B 直接读该文件名 -> $code (期望 404)" '[ "$code" = "404" ]'
code="$(curl -s -o /dev/null -w '%{http_code}' -b "$TMP/b.jar" "$BASE/hermes/__hermes_backend/api/files/read?path=../.env")"
check "$B 路径穿越读 .env -> $code (期望 4xx)" '[ "${code#4}" != "$code" ]'

echo "== 6. 会话隔离：$A 的 cookie 拿不到 $B 的容器"
ua="$(curl -s -b "$TMP/a.jar" "$BASE/hermes/__entry/me" | tr -d ' ')"
check "$A 的 /me 是 $A" 'printf "%s" "$ua" | grep -q "\"user_id\":\"$A\""'

echo
echo "PASS=$pass FAIL=$fail"
[ "$fail" = "0" ]
