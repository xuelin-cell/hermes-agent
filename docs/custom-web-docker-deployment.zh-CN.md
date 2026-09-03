# 自定义 Hermes Web 服务端部署手册

本文记录 `develop-uni` 分支在现有业务服务器上的实际部署方式。该方案使用本仓库改造后的 `apps/desktop` 浏览器页面，不使用 1Panel 应用商店安装的 Hermes 原生 Web 页面。

## 1. 部署边界与架构

服务器上两套 Hermes 相互独立：

| 服务 | 镜像/来源 | 监听端口 | 用途 |
| --- | --- | --- | --- |
| 1Panel Hermes | `1panel/hermes-agent:*` | `9119` | 由 1Panel 管理，不属于本部署 |
| 自定义 Hermes | `hermes-custom:dev` | `127.0.0.1:9120` | 本仓库构建的后端 |
| 自定义 Web 入口 | 系统 Nginx | `192.168.2.71:18080` | 静态前端及后端反向代理 |

请求链路如下：

```text
浏览器 http://192.168.2.71:18080/hermes/
  └─ Nginx
      ├─ /hermes/                         -> 自定义静态前端
      ├─ /hermes/api/ws                   -> 127.0.0.1:9120/api/ws
      └─ /hermes/__hermes_backend/*       -> 127.0.0.1:9120/*
```

后端仅监听回环地址，外部访问统一经过 Nginx。部署脚本只重建 `hermes-custom-backend`，不会操作 1Panel Hermes 或其他业务容器，也不会执行 Docker 全局清理。

## 2. 服务端目录结构

```text
/mnt/hermes-agent/                         # Git 仓库
├── apps/desktop/                          # 自定义 Electron/React 前端源码
│   └── dist-browser/                      # 当前构建产物（中间产物）
├── Dockerfile                             # 后端生产镜像定义
└── scripts/deploy-custom-web.sh           # 部署脚本（不包含 git pull）

/mnt/hermes-runtime/                       # 运行数据，不纳入 Git
├── compose.yaml                           # 自定义后端 Compose 配置
├── hermes.env                             # 后端环境变量及会话 Token，权限 600
├── data/                                  # 持久化的 HERMES_HOME
├── releases/                              # 按 Git 版本和时间保存的前端发布
│   └── <revision>-<timestamp>/
├── hermes -> releases/<revision>-<timestamp>  # Nginx 使用的当前前端软链
└── deploy.lock                            # 防止并发部署的锁文件

/etc/nginx/conf.d/hermes-custom.conf       # Nginx 配置
/var/log/nginx/hermes-custom-access.log    # 访问日志
/var/log/nginx/hermes-custom-error.log     # 错误日志
```

`/mnt/hermes-runtime/data` 必须持久化。不要在更新代码或清理镜像时删除它。

## 3. 前置条件

本方案假设服务器已经具备：

- Docker 和 Docker Compose V2；
- 系统 Nginx；
- Git、curl 和 flock；
- `/mnt/hermes-agent` 已检出 `develop-uni` 分支；
- `9120` 只供本机后端使用，`18080` 可供指定内网访问。

服务器是 RPM 系发行版时不要使用 `apt`。日常部署脚本在容器内完成 Node/Python 构建，不需要在宿主机安装 npm 或 Python 项目依赖。

## 4. 后端运行配置

### 4.1 Compose

`/mnt/hermes-runtime/compose.yaml` 的关键结构如下。若线上文件已经正常运行，以线上文件为准，不要在日常更新中覆盖它。

```yaml
services:
  backend:
    image: hermes-custom:dev
    container_name: hermes-custom-backend
    restart: unless-stopped
    network_mode: host
    env_file:
      - /mnt/hermes-runtime/hermes.env
    volumes:
      - /mnt/hermes-runtime/data:/opt/data
    command:
      - hermes
      - serve
      - --host
      - 127.0.0.1
      - --port
      - "9120"
      - --skip-build
```

检查配置但不启动服务：

```bash
docker compose \
  -p hermes-custom \
  -f /mnt/hermes-runtime/compose.yaml \
  config --quiet
```

### 4.2 环境文件

`/mnt/hermes-runtime/hermes.env` 至少包含：

```dotenv
HERMES_HOME=/opt/data
HERMES_DASHBOARD_SESSION_TOKEN=<64位随机十六进制字符串>
```

首次生成 Token：

```bash
openssl rand -hex 32
```

安全要求：

- Token 不得写入 Git、部署文档或聊天记录；
- 文件执行 `chmod 600 /mnt/hermes-runtime/hermes.env`；
- Nginx 中注入的 Token 必须与此文件完全一致；
- 修改 Token 后必须同步修改 Nginx 配置，并重建后端容器。

## 5. Nginx 配置

`/etc/nginx/conf.d/hermes-custom.conf`：

```nginx
server {
    listen 192.168.2.71:18080;
    server_name _;

    access_log /var/log/nginx/hermes-custom-access.log;
    error_log  /var/log/nginx/hermes-custom-error.log;
    client_max_body_size 50m;

    # 当前仅允许本机和 192.168.0.0/16 内网访问。
    allow 127.0.0.1;
    allow 192.168.0.0/16;
    deny all;

    location = / {
        return 302 /hermes/;
    }

    location = /hermes {
        return 301 /hermes/;
    }

    location = /hermes/api/ws {
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Origin "";
        proxy_set_header Host 127.0.0.1:9120;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;

        proxy_pass http://127.0.0.1:9120/api/ws?token=<与hermes.env一致的Token>;
    }

    location ^~ /hermes/__hermes_backend/ {
        proxy_set_header X-Hermes-Session-Token <与hermes.env一致的Token>;
        proxy_set_header Host 127.0.0.1:9120;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 30s;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;

        rewrite ^/hermes/__hermes_backend/(.*)$ /$1 break;
        proxy_pass http://127.0.0.1:9120;
    }

    location ^~ /hermes/ {
        alias /mnt/hermes-runtime/hermes/;
        try_files $uri $uri/ /hermes/index.html;

        add_header X-Content-Type-Options nosniff always;
        add_header X-Frame-Options DENY always;
        add_header Referrer-Policy same-origin always;
    }
}
```

关键点：

- `alias` 末尾的 `/` 不能省略；
- 前端必须使用 `--base=/hermes/` 构建；
- WebSocket 位置需要清空 `Origin`，否则后端可能返回 `403`；
- SPA 回退目标是 `/hermes/index.html`；
- 不要把后端端口 `9120` 监听到公网地址。

修改配置后执行：

```bash
nginx -t
systemctl reload nginx
systemctl is-active nginx
```

只有 `nginx -t` 成功后才能 reload。reload 不会停止其他 Nginx 站点。

## 6. 部署脚本的行为

`scripts/deploy-custom-web.sh` 会依次执行：

1. 检查 Compose、环境文件和 Git 工作区；
2. 获取当前 Git revision；
3. 在 Node 容器中从仓库根目录执行 `npm ci`；
4. 在 `apps/desktop` 中以 `/hermes/` 为基础路径构建自定义前端；
5. 将前端复制到版本化 release 目录；
6. 构建 `hermes-custom:<revision>` 和 `hermes-custom:dev` 后端镜像；
7. 只重建 Compose 中的 `backend` 服务；
8. 等待 `http://127.0.0.1:9120/api/health` 健康检查；
9. 健康后原子切换前端软链；失败时尝试回滚后端镜像。

脚本不会：

- 自动执行 `git pull`；
- 修改 Nginx；
- 重启 Docker daemon；
- 操作 1Panel Hermes；
- 执行 `docker system prune` 或删除共享镜像、卷；
- 自动删除旧 release 和回滚镜像。

首次构建会下载较多 Node、Python 和浏览器依赖，耗时较长。后续依赖清单未变化时会复用 Docker/BuildKit 缓存。

## 7. 首次部署

首次部署前确认：

```bash
cd /mnt/hermes-agent
git branch --show-current
git status --short
test -s /mnt/hermes-runtime/hermes.env
docker compose -p hermes-custom \
  -f /mnt/hermes-runtime/compose.yaml config --quiet
ss -lntp | grep ':9120\b' || echo "9120 端口空闲"
```

`git status --short` 应无输出。随后运行：

```bash
cd /mnt/hermes-agent
bash scripts/deploy-custom-web.sh
```

成功标志：

```text
==> Deployment complete
Revision: <revision>
Backend:  hermes-custom:<revision>
Frontend: /mnt/hermes-runtime/hermes -> /mnt/hermes-runtime/releases/...
Health:   http://127.0.0.1:9120/api/health
```

## 8. 日常代码更新与部署

拉取与部署刻意分开。每次更新执行：

```bash
cd /mnt/hermes-agent
git pull --ff-only
git status --short
bash scripts/deploy-custom-web.sh
```

`git pull --ff-only` 避免服务器生成意外的合并提交。若 `git status --short` 有输出，不要直接执行 `git reset --hard`；先确认这些修改是否需要保留。

仓库使用 GitCode SSH remote 时，建议使用专用 SSH 别名：

```text
origin  git@gitcode-hermes:uni-ai/hermes-agent.git
```

对应 `/root/.ssh/config`：

```sshconfig
Host gitcode-hermes
    HostName gitcode.com
    User git
    IdentityFile /root/.ssh/gitcode_hermes_ed25519
    IdentitiesOnly yes
```

## 9. 部署后验证

```bash
docker ps --filter name=hermes-custom-backend

docker image inspect hermes-custom:dev \
  --format 'image={{.RepoTags}} size={{.Size}} created={{.Created}}'

curl -fsS --max-time 10 \
  http://127.0.0.1:9120/api/health

curl -I --max-time 10 \
  http://192.168.2.71:18080/hermes/

readlink -f /mnt/hermes-runtime/hermes

cd /mnt/hermes-agent
git status --short
```

预期结果：后端容器为 `Up`，健康检查成功，Web 返回 `200 OK`，前端软链指向本次 release，Git 工作区无输出。

查看故障日志：

```bash
docker logs --tail 200 hermes-custom-backend
tail -100 /var/log/nginx/hermes-custom-error.log
```

## 10. 回滚

部署脚本会在覆盖 `hermes-custom:dev` 前将旧镜像标记为 `hermes-custom:rollback`。新后端健康检查失败时脚本会自动尝试回滚。

需要人工回滚后端时：

```bash
docker tag hermes-custom:rollback hermes-custom:dev
docker compose \
  -p hermes-custom \
  -f /mnt/hermes-runtime/compose.yaml \
  up -d --force-recreate --no-deps backend
curl -fsS --max-time 10 http://127.0.0.1:9120/api/health
```

前端 release 默认保留。查看候选版本：

```bash
ls -ld /mnt/hermes-runtime/releases/*
readlink -f /mnt/hermes-runtime/hermes
```

切换前端前应确认目标目录包含 `index.html`。不要删除当前软链指向的 release。

## 11. 常见故障

### 页面返回 500

若 Nginx 日志出现 `rewrite or internal redirection cycle`，通常是 `alias` 缺失、目录写错或 `index.html` 不存在：

```bash
ls -l /mnt/hermes-runtime/hermes/index.html
nl -ba /etc/nginx/conf.d/hermes-custom.conf
```

### 页面提示无法连接 Gateway

先检查后端，再检查 WebSocket：

```bash
curl -fsS http://127.0.0.1:9120/api/health
docker logs --tail 100 hermes-custom-backend
```

常见原因是 Nginx Token 与 `hermes.env` 不一致，或 WebSocket 配置没有 `proxy_set_header Origin "";`。

### 脚本提示工作区有修改

```bash
cd /mnt/hermes-agent
git status --short
git diff --name-only
```

旧版 Git 不支持 `git restore` 时，可在确认只需丢弃某个文件修改后执行：

```bash
git checkout -- <明确的文件路径>
```

不要对整个仓库执行破坏性的恢复命令。

### 构建时间很长

首次构建完整生产镜像会安装通用模型、消息平台和浏览器依赖，这是当前 Dockerfile 的预期行为。不要执行 `docker builder prune`、`docker system prune`，否则下次可能重新下载全部依赖。

## 12. 安全与共存注意事项

- 当前 `allow 192.168.0.0/16` 只适合可信内网；开放公网前必须增加 HTTPS 和独立的用户认证层。
- Nginx 配置中包含后端会话 Token，因此配置文件应限制读取权限。
- 不要在命令输出、截图、Issue 或提交中暴露 Token/API Key。
- 不要重启 Docker daemon；这可能影响服务器上所有容器。
- 不要执行 Docker 全局 prune；它可能删除其他业务依赖的缓存或资源。
- 镜像构建受 CPU 和内存参数限制，但仍会与其他业务竞争磁盘和网络 IO，建议在低峰期部署。
- 1Panel 安装的 Hermes 由 1Panel 独立管理，不要复用其容器名、端口、卷或 Compose 项目名。

