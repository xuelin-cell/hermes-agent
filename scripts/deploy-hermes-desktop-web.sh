#!/usr/bin/env bash
set -euo pipefail

APP_ROOT=/opt/hermes-browser
APP_DIR="$APP_ROOT/app"
DATA_DIR="$APP_ROOT/data"
FRONTEND_ROOT="$APP_ROOT/frontend"
FRONTEND_ARCHIVE=/tmp/hermes-desktop-web-20260902.tar.gz
ENV_FILE=/etc/hermes-desktop-web.env
CREDENTIAL_FILE=/root/.hermes-desktop-web-credentials
HTPASSWD_FILE=/www/server/nginx/conf/hermes-desktop-web.htpasswd
NGINX_INCLUDE=/www/server/nginx/conf/vhost/hermes-desktop-web.inc
NGINX_SITE=/www/server/panel/vhost/nginx/node_finance-consult.conf
SERVICE_FILE=/etc/systemd/system/hermes-desktop-web.service

if [[ ! -x "$APP_DIR/.venv/bin/hermes" ]]; then
  echo "Hermes virtual environment is not ready: $APP_DIR/.venv" >&2
  exit 1
fi
if [[ ! -s "$FRONTEND_ARCHIVE" ]]; then
  echo "Frontend archive is missing: $FRONTEND_ARCHIVE" >&2
  exit 1
fi
if [[ ! -f "$NGINX_SITE" ]]; then
  echo "Expected nginx site is missing: $NGINX_SITE" >&2
  exit 1
fi

if ! id hermesweb >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /sbin/nologin hermesweb
fi
install -d -m 0750 -o hermesweb -g hermesweb "$DATA_DIR"
install -d -m 0755 "$FRONTEND_ROOT"

release="$FRONTEND_ROOT/releases/$(date +%Y%m%d%H%M%S)"
install -d -m 0755 "$release"
tar -xzf "$FRONTEND_ARCHIVE" -C "$release"
test -s "$release/index.html"
find "$release" -type d -exec chmod 0755 {} +
find "$release" -type f -exec chmod 0644 {} +
ln -sfn "$release" "$FRONTEND_ROOT/current"

if [[ ! -s "$ENV_FILE" ]]; then
  backend_token="$(openssl rand -hex 48)"
  cat >"$ENV_FILE" <<EOF
HERMES_DASHBOARD_SESSION_TOKEN=$backend_token
HERMES_HOME=$DATA_DIR
HERMES_DESKTOP=1
PYTHONUNBUFFERED=1
EOF
  chmod 0600 "$ENV_FILE"
fi
backend_token="$(sed -n 's/^HERMES_DASHBOARD_SESSION_TOKEN=//p' "$ENV_FILE" | head -n 1)"
if [[ -z "$backend_token" ]]; then
  echo "Backend token is missing from $ENV_FILE" >&2
  exit 1
fi

if [[ ! -s "$CREDENTIAL_FILE" ]]; then
  basic_password="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)"
  cat >"$CREDENTIAL_FILE" <<EOF
username=hermes
password=$basic_password
EOF
  chmod 0600 "$CREDENTIAL_FILE"
fi
basic_username="$(sed -n 's/^username=//p' "$CREDENTIAL_FILE" | head -n 1)"
basic_password="$(sed -n 's/^password=//p' "$CREDENTIAL_FILE" | head -n 1)"
printf '%s:%s\n' "$basic_username" "$(openssl passwd -apr1 "$basic_password")" >"$HTPASSWD_FILE"
chown root:www "$HTPASSWD_FILE"
chmod 0640 "$HTPASSWD_FILE"

cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=Hermes Desktop Web backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hermesweb
Group=hermesweb
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$APP_DIR/.venv/bin/hermes serve --host 127.0.0.1 --port 9120 --skip-build
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$SERVICE_FILE"

cat >"$NGINX_INCLUDE" <<EOF
location = /hermes {
    return 301 /hermes/;
}

location = /hermes/api/ws {
    auth_basic "Hermes Desktop";
    auth_basic_user_file $HTPASSWD_FILE;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host 127.0.0.1:9120;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 1800s;
    proxy_send_timeout 1800s;
    proxy_pass http://127.0.0.1:9120/api/ws?token=$backend_token;
}

location ^~ /hermes/__hermes_backend/ {
    auth_basic "Hermes Desktop";
    auth_basic_user_file $HTPASSWD_FILE;
    proxy_set_header X-Hermes-Session-Token $backend_token;
    proxy_set_header Host 127.0.0.1:9120;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_connect_timeout 30s;
    proxy_read_timeout 1800s;
    proxy_send_timeout 1800s;
    rewrite ^/hermes/__hermes_backend/(.*)\$ /\$1 break;
    proxy_pass http://127.0.0.1:9120;
}

location ^~ /hermes/ {
    auth_basic "Hermes Desktop";
    auth_basic_user_file $HTPASSWD_FILE;
    alias $FRONTEND_ROOT/current/;
    try_files \$uri \$uri/ /hermes/index.html;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy same-origin always;
}
EOF
chmod 0600 "$NGINX_INCLUDE"

include_line="    include $NGINX_INCLUDE;"
if ! grep -Fq "$include_line" "$NGINX_SITE"; then
  cp -a "$NGINX_SITE" "$NGINX_SITE.before-hermes-$(date +%Y%m%d%H%M%S)"
  python3 - "$NGINX_SITE" "$include_line" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
include_line = sys.argv[2]
text = path.read_text()
needle = "    location / {"
if needle not in text:
    raise SystemExit("Could not find the root location insertion point")
path.write_text(text.replace(needle, include_line + "\n\n" + needle, 1))
PY
fi

systemctl daemon-reload
systemctl enable --now hermes-desktop-web.service
/www/server/nginx/sbin/nginx -t
systemctl reload nginx

echo "DEPLOYED_USERNAME=$basic_username"
echo "DEPLOYED_PASSWORD=$basic_password"
echo "DEPLOYED_URL=https://xinyejianqianshenqi.cn/hermes/"
