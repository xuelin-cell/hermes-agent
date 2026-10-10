#!/usr/bin/env bash
# /opt/mt/screen-entrypoint.sh
#
# 在容器启动时拉起「虚拟屏幕四件套」，然后 exec 后续入口链
# (cube-entrypoint.sh → envd 后台 → dispatcher → main-wrapper → forward.py)。
#
# 四件套（与 sandbox-screen-access-guide.html 一致）：
#   Xvfb        :99  虚拟帧缓冲（-ac 关闭访问控制，hermes 用户也能连）
#   fluxbox          窗口管理器（否则 noVNC 里是空 X，看不到「桌面」）
#   x11vnc           把 :99 暴露成 VNC :5900（用 /root/.vnc/passwd 鉴权）
#   websockify       VNC → WebSocket，浏览器经 :6080 直连 noVNC
#
# DISPLAY=:99 由 Dockerfile 的 ENV 注入；forward.py 的 _spawn_hermes 用
# dict(os.environ) 透传给 hermes，computer_use 的 cua_backend 据此连上 X。
set -euo pipefail

# 解析 DISPLAY（:99 → 99）。Dockerfile 里 ENV DISPLAY=:99。
DISPLAY_NUM="${DISPLAY#:}"

# 允许覆盖的参数（带默认值）。
RES="${RES:-1280x720x24}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_PASSWORD_FILE="${VNC_PASSWORD_FILE:-/root/.vnc/passwd}"

echo "[screen] starting Xvfb on :${DISPLAY_NUM} (${RES})"
# -ac            关闭访问控制，非 root 的 hermes 用户也能连 :99
# +extension ... 显式启用 RANDR/GLX，部分 X 应用需要
Xvfb ":${DISPLAY_NUM}" -screen 0 "${RES}" -ac +extension RANDR +extension GLX \
    >/var/log/xvfb.log 2>&1 &

# 等 Xvfb 就绪（X socket 出现即可，最多 ~5s）。
# x11vnc / fluxbox 比 Xvfb 启动慢，过早连会失败 —— 这里只等 X socket，
# 后续 x11vnc/fluxbox 各自有重试。
for _ in $(seq 1 50); do
    [ -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ] && break
    sleep 0.1
done

echo "[screen] starting fluxbox window manager"
# DISPLAY 已在环境里；fluxbox 找不到配置也能裸跑（空桌面 + 右键菜单）。
DISPLAY=":${DISPLAY_NUM}" fluxbox >/var/log/fluxbox.log 2>&1 &

echo "[screen] starting x11vnc (VNC :5900)"
# -forever  连接断开后继续监听（默认是退出）
# -shared   允许多端同时连（noVNC + 调试）
# -rfbauth  用构建时生成的密码文件鉴权
# -bg       后台运行，日志写 /var/log/x11vnc.log
x11vnc -display ":${DISPLAY_NUM}" -forever -shared \
    -rfbauth "${VNC_PASSWORD_FILE}" \
    -bg -o /var/log/x11vnc.log

echo "[screen] starting websockify (noVNC :${NOVNC_PORT})"
# websockify 把 VNC :5900 包成 WebSocket，noVNC 前端经此连入。
# --web 指向 novnc 的静态文件目录，浏览器打开 http://<host>:6080/vnc.html
websockify --web=/usr/share/novnc "${NOVNC_PORT}" localhost:5900 \
    >/var/log/websockify.log 2>&1 &

echo "[screen] screen stack up; handing off to cube-entrypoint chain"

# exec 后续入口链：cube-entrypoint.sh（后台 envd → 前台 exec dispatcher）。
# "$@" = "/usr/local/bin/cube-entrypoint.sh /opt/hermes/docker/entrypoint-dispatch.sh"
# （CMD "python3 /opt/mt/forward.py" 由 Docker 拼到 ENTRYPOINT 末尾。）
exec "$@"
