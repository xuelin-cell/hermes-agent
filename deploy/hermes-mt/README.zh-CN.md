# Hermes 多租户部署（一用户一容器）

在现有「自定义 Web 单用户部署」（`docs/custom-web-docker-deployment.zh-CN.md`）之上加一层**入口服务**，
让同一台机器上每个登录用户各自拥有一个 `hermes serve` 容器、一个数据卷、一个网络。
**hermes 镜像和前端一个字节都不改**，用的还是 `hermes-custom:dev` 和 `apps/desktop` 的浏览器版构建。

```
浏览器 ──▶ Nginx(:18081)
             ├─ /hermes/                 静态 SPA（auth_request 问入口：没登录 → 302 /hermes/login）
             ├─ /hermes/login, /hermes/__entry/*   入口自己的登录页与接口
             ├─ /hermes/api/ws           ─┐
             └─ /hermes/__hermes_backend/ ─┴─▶ 入口服务(:9400)：验 cookie → 该用户容器 → 注入该容器 token → 原样透传
                                                  │  每个用户一个 bridge 网络 hermes-net-<uid>，入口连进去
                                                  ▼
                                    容器 hermes-t-<uid>：卷里的 forward.py 0.0.0.0:9121 → 127.0.0.1:9120 hermes serve
                                    卷 hermes-data-<uid> → /opt/data（state.db / memories / skills / .env / config.yaml）

入口服务 ──▶ PostgreSQL：用户、浏览器登录、租户运行态、套餐配置、加密凭据和审计
```

## 目录

| 路径 | 作用 |
|---|---|
| `compose.yaml` | 常驻三个服务：`postgres`、`entry`、`nginx`。租户容器**不在 compose 里**，由入口按需起 |
| `entry/` | 入口服务（Python 3.13 + aiohttp，单进程）。`entry/entry/*.py` 见文件头注释 |
| `seed/forward.py` | 放进每个租户卷 `/opt/data/.mt/` 的 TCP 转发器（标准库，30 行） |
| `seed/config.yaml.tmpl` | 每个租户首次建卷时写入的 `config.yaml` 模板 |
| `nginx/hermes-mt.conf` | 由 `.7` 单用户版的 Nginx 配置改来：两处 `proxy_pass` 指向入口，去掉写死的 token，静态加 `auth_request` |
| `scripts/build-frontend.sh` | 构建浏览器版前端到 `nginx/dist-browser/`（与 `deploy-custom-web.sh` 同一条 vite 命令） |
| `scripts/verify_isolation.sh` | 验收 27 项：登录门禁 / 两个用户各自的世界 / 网络围栏 / 文件链路与文件隔离 |
| `scripts/verify_ws_keepalive.py` | 回归：ws 静默挂着时容器不被空闲回收停掉 |
| `entry.env.example` | 入口的环境变量样例；复制成 `entry.env`（已 gitignore） |
| `deploy.sh` | 沙箱后端的一键部署 / 升级脚本（见下「一键部署」）；`seed/mtstate.py` 是实例里的状态管家，负责把用户状态归档到卷、重建时恢复 |

## 浏览器 MaaS 凭据基础

登录成功后，独立登录页把 `maas_auth` 保存到按 base_path 隔离的 localStorage。入口继续用原有
HttpOnly session cookie 认证，并额外签发只含摘要的认证加密关联 cookie；不在 PG 保存 MaaS token 或其哈希。
`POST /__entry/maas-auth` 校验当前 cookie 与 Bearer token 的绑定及期限，不请求上游、不返回 token。

登录页与 renderer 共用源码 `apps/shared/src/browser-maas-auth.js`，部署构建会生成入口 static 副本。后续分享/网盘的页面请求使用
`requestEntryMaas`，入口业务路由使用 `_require_maas`。通用实例代理移除 Authorization，避免凭据透传。
旧 session 使用新业务前需重新登录；部署时前端与入口同步更新。页面分享已接入，网盘及 agent 授权通道仍待接入。
完整设计和当前验收结果见 [实施方案](docs/cloud-browser-token-sharing-drive-plan.md#14-本轮已实现的基础能力2026-10-26)。

## 云端分享

会话/单条回复和产物分享复用桌面页面，通过 `/__entry/conversation-shares/*` 和
`/__entry/artifact-shares/*` 调用固定 MaaS 分享网关。入口从当前浏览器请求取得 token，
PG 只保存分享归属、快照与待确认操作（迁移 `007_shares.sql`），不保存 MaaS token。

实例使用 `cloud_sharing.enabled: true` 开启来源记录；由现有平台策略在引导时写入，
复用桌面 provenance 钩子，记录保存在所属 home 的 `cloud-artifact-origins.db`。
本轮之前的产物没有可信来源记录时仍不能发布，需要在新实例配置下生成新的产物。
更新时必须同时发布入口、浏览器前端和含 overlay 的实例模板；旧实例需走模板换代引导。

默认产物期限为一天，可选 1～7 天。到期删除在用户持有效凭据再次查看分享时尝试，
并保留失败状态供重试；当前网关没有原生 TTL，不能保证到期瞬间公网链接失效。
agent 自动发布和云盘不包含在本次页面分享接入中。

## 一键部署（沙箱后端，推荐）

改一项配置（例如打开长期空闲删实例）：`./deploy.sh set MT_IDLE_DELETE_HOURS=24 && ./deploy.sh up`。

部署机上以 root 运行，所有手册里的检查都在脚本里：

```bash
cd deploy/hermes-mt
# 首次：生成 entry.env（密钥现场随机、600）和 compose.override.yaml
./deploy.sh init --http-port 192.168.x.x:18081 --cube-api http://<控制面>:3000 --cube-proxy http://<数据面>
# 之后每次部署 / 升级都只有这一条，屏幕上实时显示进度（开头会说这次要做哪些耗时的步骤）：
#   拉代码 → 基础镜像(按需) → 前端(按需) → 检查 → 沙箱镜像(按需) → 模板(按需) → 写配置 → 起容器 → 验收
./deploy.sh all
# 部署其实在后台跑：Ctrl+C、终端断开都只是不看了，部署照样跑完。重新连上后接着看（跑完了就打出结果）：
./deploy.sh log
./deploy.sh status      # 看现状；./deploy.sh check 只读检查
```

同一时间只跑一次部署：已经有一次在跑时再敲 `all`，不会起第二次，直接接着看那一次。每次的日志在 `.deploy-logs/`（`latest.log` 是最近一次）。输出重定向到文件时（`nohup ./deploy.sh all > 文件 2>&1 &` 的老写法）照常在前台跑，也能用。

构建时每 30 秒显示累计耗时和最新输出；基础镜像、沙箱镜像的完整日志分别为 `.base-build.log`、`.image-build.log`。
生成的基础镜像 Dockerfile 默认使用国内 apt 源和 npm 源，不修改根目录 Dockerfile。
前端构建阶段设置 npm 源；运行阶段只给安装命令设置，不改变应用运行时的默认 npm 配置。
手工构建派生 Dockerfile 时，可用 `--build-arg APT_MIRROR=` 恢复官方 apt 源、
`--build-arg NPM_REGISTRY=https://registry.npmjs.org` 恢复官方 npm 源。已有基础镜像仍按原指纹复用，换源在下次实际构建时生效。

耗时：只改了入口或配置几分钟；改了前端多 5~10 分钟；hermes 源码变了（合了上游、桌面版改了插件或内置技能）基础镜像要重建 15~45 分钟，沙箱镜像也跟着整个重建 20~40 分钟。

要点：沙箱镜像按内容指纹命名（`Dockerfile.cube` + `seed/*` + 基础镜像 + 模板参数），只改入口代码不会重做镜像和模板；改了转发器就一定重做，并把新模板 ID 写进 `entry.env`。**入口和沙箱模板必须一起升级**——新入口配旧转发器会把用户的 `config.yaml` 写坏，脚本保证这一点。入口发现实例的模板和配置不一致，会在用户下次请求时自动排空、删除、重建、从卷上的归档恢复。部署机的规矩（不重启 Docker、不 prune、不切换构建器、页面只绑内网 IP、不打印密钥）也都在脚本里。

**基础镜像**：沙箱镜像叠在基础镜像（hermes 本体）上。基础镜像用本仓库根目录的 `Dockerfile` 构建，和桌面版同一份（只补了一行它漏掉的 `COPY scripts/build/filesystem.py`），里面是 hermes 代码、内置技能（`skills/uniwork`）和 pm 锁定的 Python 3.14、Node、Chromium、ffmpeg、ripgrep（都在 `/opt/hermes/tools`；uv 不在 PATH 上）。镜像名 `hermes-custom:src-<指纹>`，指纹只算 hermes 源码（不含 `apps/`、`deploy/`、`docs/`、`tests/`、`website/`），所以只改前端或部署脚本不用重建；`./deploy.sh all` 找不到当前指纹的基础镜像会自己先建（也可以提前单独跑 `./deploy.sh base`）。部署机连 GitHub 极慢、连不上 Playwright 的 CDN，所以 `deploy.sh base` 先用 `scripts/base_seed.py` 把 pm 锁定的 7 个大文件（uv、Python、Chromium、node、npm、ffmpeg、ripgrep）和 s6-overlay 的三个包按 sha256 备好：pm 的文件来源依次是 hermes 的公开镜像、npmmirror、原地址；s6-overlay 的包公开镜像上没有，放在仓库的 `vendor/s6-overlay/` 里随代码拉下来（上游升了 s6 版本要把新包放进去，测试会提醒）；目录是 `MT_DEPLOY_SEED_DIR`（默认 `/var/cache/hermes-mt/base-seed`，备好的不重下）。然后用它生成的 Dockerfile 副本构建：副本只比原文件多两行 COPY，上游文件本身不改。构建本身只再连 PyPI、npm 和 Debian 源。以前按摘要拉的 `hermes-custom:a2007f2` 不能再用：它没有内置技能的标记文件，`deploy.sh` 会拦下。`entry.env` 里如果写了 `MT_DEPLOY_BASE_IMAGE`，就固定用它，一般不要写。

**前端**：浏览器版前端（`nginx/dist-browser/`）不进 git，由 `scripts/build-frontend.sh` 从本仓库构建（`apps/desktop` 加 `VITE_HERMES_BROWSER_BUILD=1`，和桌面版同一份代码）。构建时把前端指纹写进产物（`dist-browser/.source-fingerprint`，`nginx/.dockerignore` 不让它进镜像）；指纹算 `apps/`、根目录的 `package.json` / `package-lock.json` / `.npmrc`、构建脚本和 `vendor/npm/`。`./deploy.sh all` 和 `up` 比对它和当前代码的指纹，对不上就先重新构建，不会把旧前端发出去；完整输出在 `.frontend-build.log`。`bash scripts/build-frontend.sh --fingerprint` 只打印当前代码的前端指纹。

**实例里给技能用的东西**（`Dockerfile.cube`）：LibreOffice（文件预览转 PDF、文档类技能）、poppler、系统 Chromium（frontend-design 截图）、字体；技能要的 Python 库装进 hermes 的 venv（已有的 hermes 依赖钉在原版本，不会被顺带升级）；agent 的终端命令在登录 shell 里跑，`/etc/profile` 会把 PATH 重置成系统默认值，镜像 ENV 里的 `/opt/hermes/bin`、`/opt/hermes/.venv/bin`、`/opt/data/.local/bin` 都会丢，`python3` 落到不带库的 Python（旧镜像也这样），所以 `/etc/profile.d/hermes-path.sh` 把这几项补回来，agent 终端和用户的终端面板用的是同一个 Python；Python 版 Playwright 锁在和 pm 那份 Chromium 同一个修订号，只补 headless shell（`PLAYWRIGHT_SKIP_BROWSER_GC=1`，否则会把 pm 的 Chromium 当旧版删掉）；uniai-ppt 要的 pptxgenjs 装在 `/opt/skill-node`，靠 `NODE_PATH` 让任何目录下的脚本都能 `require`。

## 前置条件

- docker ≥ 20.10、docker compose v2（`.7` 上已验证：CentOS 7 / 3.10 内核 / docker 26.1.4）。
- 基础镜像：沙箱后端由 `./deploy.sh all` 从本仓库按需构建（见上「基础镜像」）；下面手工部署的 Docker 后端用 `hermes-custom:dev`，按 `docs/custom-web-docker-deployment.zh-CN.md` 构建。
- 浏览器版前端产物：沙箱后端由 `./deploy.sh all` / `up` 按需构建（见上「前端」）；下面手工部署的 Docker 后端用 `bash deploy/hermes-mt/scripts/build-frontend.sh`，或直接复制现网 release：
  `cp -a /mnt/hermes-runtime/hermes/. deploy/hermes-mt/nginx/dist-browser/`（注意末尾 `/.`）。
- 与单用户版**并存**：端口默认 `18081`（单用户版是 `18080`），容器名前缀 `hermes-mt-` / `hermes-t-`，互不冲突。

## 部署

```bash
cd deploy/hermes-mt
cp entry.env.example entry.env          # 生产：MT_DEV_LOGIN=0；其余按需
# 生成 MT_CREDENTIAL_KEY 后写回 entry.env：
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
bash scripts/build-frontend.sh          # 或复制现网 release，见上
docker compose -p hermes-mt up -d --build
curl -s http://127.0.0.1:18081/hermes/__entry/health   # database=ok 才算健康
python scripts/verify_postgres.py
```

PostgreSQL 只发布到 `127.0.0.1:${MT_POSTGRES_PORT:-15432}`，数据保存在独立命名卷
`hermes-mt-postgres`。Entry 启动时自动执行有序 SQL 迁移；数据库未就绪或迁移失败时
Entry 不进入健康状态，Nginx 也不会提前接流量。

浏览器打开 `http://<host>:18081/hermes/` → 被带到登录页 → 手机号 + 图形验证码 + 短信验证码 → 登录成功后入口
后台拉起该用户的容器（首次十几秒），页面进入聊天界面。

**谁在登录 / 退出**：页面底部状态栏有账号那一项，显示当前账号（短信登录显示打码手机号）和「退出」，
和桌面版是同一个组件。垫片（`apps/desktop/src/dev/browser-bridge.ts`）的 `getMaasAccount` 读入口的
`/__entry/me`，会话到期后账号旁标「登录已到期」；点退出、确认后跳到 `<base>/logout`（结束会话，回登录页），
也可以直接访问这个地址。

验收（需要临时 `MT_DEV_LOGIN=1`，不用短信，两个假用户 alice/bob）：

```bash
BASE=http://127.0.0.1:18081 bash scripts/verify_isolation.sh        # 27 项，期望 FAIL=0
# 空闲回收的回归（要把 MT_IDLE_MINUTES 临时调成 1 并重启 entry）：
BASE=http://127.0.0.1:18081 python scripts/verify_ws_keepalive.py
```

## 入口做的事（也是它不做的事）

收到请求：① 验 cookie → userid ② 查/建该用户的网络、卷、容器，等 `/api/health` 就绪 ③ ws 追加 `?token=<该容器的
HERMES_DASHBOARD_SESSION_TOKEN>`，REST 加 `X-Hermes-Session-Token` ④ `Host` 改成 `127.0.0.1:9120`、不转发 `Origin` 和
`Cookie` ⑤ 其余字节原样透传。**不解析、不改写任何 hermes 协议**；拿掉入口、Nginx 直连任一容器，前端应完全正常。

登录：图形验证码、短信发码、短信登录都由入口代理到 MaaS（`MT_MAAS_APP`）；登录成功后用返回的 JWT 调 `my-plan`
拿这个用户自己的模型 key，以 Fernet 密文保存进 PostgreSQL，再通过 Hermes 现有 `/api/env`
写进他的卷（`.env` 的 `HERMES_CUSTOM_YUANJING_API_KEY`），
**并用 my-plan 同时下发的 `base_url` / 模型名写他的 `config.yaml`**。
★★ 套餐 key **只在 my-plan 给的那个「TokenPlan 专用路径」上有效**：打手写的通用网关地址会被回
`{"code":1004,"msg":"当前请求路径错误，请使用 TokenPlan 专用路径发起请求"}`。`MT_MODEL_BASE_URL`
只是 my-plan 没给 base_url 时的兜底，正常路径上不该用到它（用到了会打 WARNING）。
上游给的 base_url 少末尾 `/v1`，入口自动补。
★ **套餐里的全部模型都要写进 `providers.<key>.models`**：界面的模型下拉读的是这个映射，不是
`default_model`；只写主模型，用户就只看得到一个（实测套餐有 3 个模型时只显示 1 个）。
端点或模型清单任一变化都会触发同步（`.mt/endpoint.stamp` 记的是两者）。JWT 不验签、不解码，只信
登录那一跳；入口自己签不透明的 cookie，有效期不超过上游给的 `expiresAt`。**没套餐 = 没 key**，不会拿平台的 key 兜底。

同一把套餐 key 也给内置的元景 MCP 用（搜图、文生图等）：入口每次引导在 `config.yaml` 写 `mcp_servers.yuanjing`，地址是
`MT_YUANJING_MCP_URL?key=${HERMES_CUSTOM_YUANJING_API_KEY}&client_id=UniWork&oss_mode=internal`，key 由 hermes 连接时从 `.env` 取，配置文件里没有明文。
`client_id` 要在元景 mcp-server 的白名单里，否则套餐 key 调下游会回 1004。`oss_mode=internal` 让工具产出的文件给内网链接
（云端版用户的浏览器在内网，公网链接打不开），`MT_YUANJING_MCP_OSS_MODE` 设成空就不带。没套餐的用户不写这一条；地址设成空就是不提供。
这一条归平台：每次引导都按入口的配置重写它的地址和超时，用户手改的地址会被改回（用户的开关、自己加的别的 MCP 不动）。

**技能**：用户只拿到 UniWork 的内置技能（`skills/uniwork/`，和桌面版同一套），hermes 上游自带的那一大套不给（只留 hermes 必需的 hermes-agent）。规则在 hermes 里、桌面版和云端共用：有 `skills/UNIWORK_BUNDLED_ONLY` 这个标记文件时，`tools/skills_sync.py` 只同步 `skills/uniwork/`；用户手里已经不再发行的技能（包括以前同步进去的上游技能、下架的旧内置技能），没改过的删掉，改过的移进 `~/.hermes/skills/.retired-hermes/`；agent 自己写的、从技能市场装的不动。容器启动时那一遍同步早于恢复用户目录，hermes serve 启动时又不同步，所以转发器在每次引导、恢复完用户目录之后再跑一遍（`seed/forward.py` 的 `_sync_bundled_skills`，结果在引导回包的 `skills` 里）。基础镜像必须是本仓库构建的（带这个标记文件），`deploy.sh` 构建模板时会检查。

重新登录会重新读取 MaaS 当前返回的 Key，但不假设 MaaS 每次都会生成新 Key。若 Key 发生变化，
Entry 不重启租户容器，而是原子更新卷内 `.env`；该用户所有已有会话在各自的**下一轮对话开始时**
复用 Hermes 现有刷新逻辑重建模型客户端。已经执行中的一轮不会中途换 Key。

Entry 平台表只采用以下约定：`users.masked_phone` 保存脱敏手机号；`tenant_runtime.state`
只使用 `starting`、`running`、`stopped`；`tenant_credentials` 使用固定的
`MT_CREDENTIAL_KEY` 加密模型 Key 和容器令牌，不保存密钥版本。

## 运行与维护

| 事 | 怎么做 |
|---|---|
| 看有哪些租户在跑 | `docker ps --filter label=hermes.mt=tenant`；或 `curl :18081/hermes/__entry/health` |
| 某用户的 hermes 日志 | `docker logs hermes-t-<uid>`；卷内 `logs/`：`docker run --rm -v hermes-data-<uid>:/d alpine ls /d/logs` |
| 入口日志 | `docker logs hermes-mt-entry`（每条带 userid） |
| PostgreSQL 状态 | `docker logs hermes-mt-postgres`；表：`docker exec hermes-mt-postgres psql -U hermes_entry -d hermes_entry -c '\dt'` |
| PostgreSQL 持久卷 | `docker volume inspect hermes-mt-postgres`；不要直接修改卷内文件 |
| 空闲回收 | 入口每分钟扫一次：**只要还挂着 ws 连接就绝不回收**；没有连接且 `MT_IDLE_MINUTES`（默认 30）内无活动才 `docker stop`，**卷不动**，下次请求再起 |
| 入口重启 / 机器重启 | Entry 先确认 PostgreSQL 并完成迁移，再开始监听；租户 reconcile 仍在后台执行，之后按需再起（租户容器 `restart=no`） |
| 停/删某个用户 | `docker rm -f hermes-t-<uid>`（数据仍在卷里）；彻底删除再 `docker volume rm hermes-data-<uid>`、`docker network rm hermes-net-<uid>` |
| 备份某个用户 | `docker run --rm -v hermes-data-<uid>:/d -v $PWD:/out alpine tar -C /d -czf /out/<uid>.tgz .`（在线备份 state.db 用 `sqlite3 .backup` 更稳） |
| 升级 hermes 镜像 | 构建新镜像 → 改 `entry.env` 的 `MT_IMAGE` → `docker compose -p hermes-mt up -d entry`。入口发现容器镜像不同会**删容器重建，卷不动** |
| 升级前端 | 重新 `build-frontend.sh` → `docker compose -p hermes-mt up -d --build nginx` |
| 换模型 Key | 用户重新登录后保存新密文并调用 `/api/env`；所有已有会话从各自下一轮开始使用新 Key |
| 停止服务 | `docker compose ... down` 不加 `-v`，会保留 PostgreSQL 和用户数据卷 |

## 与单用户版的差异，以及为什么

- **hermes 仍绑 127.0.0.1，鉴权门关着。** 绑非 loopback 地址会强制开门（`--insecure` 已失效），门开后 ws 只认 30 秒
  单次票据，浏览器版前端不会去要票据。所以在卷里放一个转发器 `0.0.0.0:9121 → 127.0.0.1:9120`，容器 CMD 是
  `sh -c 'python3 /opt/data/.mt/forward.py & exec hermes serve --host 127.0.0.1 --port 9120 --skip-build'`；
  hermes 看到的对端是 127.0.0.1，Nginx 那套 `?token=` / `X-Hermes-Session-Token` 鉴权形态原样保留。
- **不用 host 网络。** 多容器下 host 网络意味着端口冲突和容器互访。每个租户一个独立 bridge 网络，只有入口容器
  连进去；租户之间没有共同网络，互相不可达（`verify_isolation.sh` 第 4 段验这个）。
  docker 默认地址池大约够 30 个网络，用户多了在 `/etc/docker/daemon.json` 加
  `"default-address-pools":[{"base":"10.200.0.0/16","size":24}]` 后重启 dockerd。
- **卷用 named volume。** `docker run --rm -v hermes-data-<uid>:/d …` 即可读写；不依赖宿主目录布局。
- **只有入口容器挂 `/var/run/docker.sock`。** 租户容器不挂 socket、不发布宿主端口、`no-new-privileges`、
  内存/CPU/pids 有上限（`MT_MEMORY` / `MT_CPUS` / `MT_PIDS`）。
- **`docker exec` 进租户容器默认是 root**，会把卷里的文件写成 root 属主；用镜像自带的 `hermes` shim 或 `-u hermes`。
- **index.html 发 `Cache-Control: no-store`**，带哈希名的 `assets/` 才长期缓存。不这样的话，
  退出登录后再访问，浏览器直接拿磁盘缓存里的外壳渲染（实测 `200 fromCache=true`，根本不问服务器），
  看起来像没退成功——其实服务端一条数据都不给（API 全 401）。

## 两个判活/时序的坑（改之前先读这两段）

- **空闲回收按「有没有 ws 连接」判活，不按「多久没动静」。** 用户把页面开着不说话时 ws 完全静默，
  按时间判会把他的容器停掉、页面当场掉线；一次长回复的流式输出（几十分钟只有零星帧）同样会被误伤。
  入口维护 `live_ws` 计数（`/__entry/health` 可见），连接期间一律跳过回收，断开那一刻才开始计时。
  回归测试是 `scripts/verify_ws_keepalive.py`。
- **启动时的 reconcile 必须在后台。** 它要逐个 `docker stop`，6 个容器实测 6.8s；放在开始监听之前，
  这段时间 nginx 全是 `502 connection refused`，租户越多窗口越长。现在先 listen 再后台 reconcile，
  并且 reconcile 与拉起容器共用同一把 per-租户锁，避免刚起来的容器被 reconcile 停掉。

## 已知限制

1. `hermes serve` 模式**不跑定时任务**（cron ticker 只在 `HERMES_DESKTOP=1` 时启动）。
2. PostgreSQL 只保存 Entry 平台数据，**不存对话**；对话、记忆、技能和用户文件仍在各用户卷中。
3. 凭据只使用固定的 `MT_CREDENTIAL_KEY`，不提供主密钥轮换。已有加密数据后直接换 Key 会导致旧凭据无法解密；本地测试确需换 Key 时应清理 Entry 凭据、重建租户容器并让用户重新登录，用户卷不删除。
4. 镜像里没有 LibreOffice / 中文字体 / socat；agent 做 office 转换要加进 Dockerfile（构建层）。
5. 联网搜索、消息渠道未接。
6. 一台机器能跑多少用户要实测：`.7` 上单容器空闲约 780 MiB。
7. 前端登录后到容器就绪之间（首次十几秒）页面会显示「连接中」，没有专门的「正在准备工作空间」提示。
8. 状态栏在没有可用模型 key 时显示橙色的「网关 检查中」——网关其实是通的，那是推理就绪检查没过。
9. **输入框旁边的「推理强度」七档（最小…超高）对元景网关无效**。那是 Hermes 的统一词表，
   走 `extra_body.reasoning={enabled,effort}` 发出；实测元景网关不读这个字段：思考关不掉
   （`enabled:false` 仍产生 84~92 个 reasoning token）、「最小」比「超高」还多、传一个不存在的
   档位照样 200。Hermes 的规则是 provider 不声明支持列表就不做限制，所以七档全部放行、全部无效。
   要让这个下拉变诚实，得给这个 provider 声明 `supported_reasoning_efforts`（改 Hermes 侧 provider
   定义，不属于本目录的零改动范围）。

## 安全

- `MT_DEV_LOGIN=1` 只能在验收时用，它允许任意用户名免密登录。
- 走 HTTPS 时把 `MT_COOKIE_SECURE=1`。
- `entry.env` 不进 git；数据库密码和 `MT_CREDENTIAL_KEY` 只能放在环境变量中。
- 模型 Key 和租户容器令牌在 PostgreSQL 中只保存认证密文，日志、健康接口和审计不得输出明文或密文。
- PostgreSQL 本地端口只绑定 `127.0.0.1`；云端部署时应改为私有网络并配置独立备份与访问控制。


## 云盘迁移（cloud-adaptation）

生产浏览器构建复用桌面资料库，支持文件管理、电脑文件上传下载、实例产物上传、预览和主动对话中的网盘工具。
MaaS token 仍在浏览器 localStorage；入口认证加密的 HttpOnly 证明补充可信手机号，网盘 token 仅在入口内存中缓存。
旧登录需要重新短信登录才能使用云盘，开发登录没有真实网盘授权。

入口通过私有 Node stdio worker 复用桌面网盘协议，不启动 Electron；实例在现有 HTTP 后端内挂载本地 MCP，
由入口主动处理实例工具请求。不会给每个用户增加另一套网盘系统或公网端口。

- 配套部署前端、入口和新实例模板；提交所有新增文件后执行 `deploy.sh all`。
- 手工构建前，仓库根目录运行 `node apps/desktop/scripts/build-cloud-drive.mjs`；服务器前端构建脚本已包含该步骤。
- `008_drive_operations.sql` 自动迁移，只保存用户隔离的非敏感回执，完整 MaaS token 不进入 PG。
- 单文件最多 512 MiB，预览 20 MiB，浏览器分片 8 MiB，上游限制更小时取更小值；文件使用有界暂存，不承诺断点续传。
- Agent 授权每轮最多 15 分钟，默认 Profile、单入口；任务结束、取消、退出、到期或入口重启后不继续获得账号权限。
- “设置 → 安全 → 审批 → 允许智能体操控资料库”只限制 agent，页面手动管理保持可用。
- 浏览器下载只报告交付下载请求，不能声称已保存到用户磁盘。Office 预览仍需 Cube 镜像的 LibreOffice。

实现与验收说明见 [云盘迁移方案](docs/cloud-drive-migration-plan.md)。本地协议替身验证不替代真实账号和 Cube 环境联调。


## 云端套餐与用量

生产浏览器复用桌面套餐卡片，提供套餐名称、到期时间、Coding/Token 用量与并发信息（以上游实际提供为准）、
手动刷新及订阅市场入口。查询通过浏览器 MaaS 关联授权进入固定 Entry 业务路由，敏感模型配置不返回页面。
订阅点击需要允许浏览器弹窗；旧登录缺少可信手机号时需重新短信登录。
打开市场不表示购买成功，返回后以套餐查询为准；涉及模型 Key/模型列表的变更仍需重新登录同步配置。
实现、剩余边界和发布要求见 [云端套餐与用量适配](docs/cloud-plan-migration.md)。


## 导出与首页模板

Markdown 预览支持 Markdown、Word 和 PDF 导出：前两项由浏览器生成下载，PDF 使用当前用户实例的 Chromium。
实例转换不带账号凭据，不读取外部网络资源，限时运行并清理临时文件。首页分类与模板复用桌面 V3 配置客户端，
经入口鉴权获取，缓存按浏览器登录与语言隔离。

本次包含新实例文件和转发器修改，需提交推送后完整执行 `deploy.sh all` 更新模板。
实现、大小限制及验收说明见 [导出与首页适配](docs/cloud-export-welcome-migration.md)。


## 云端技能市场

推荐和市场页面复用既有列表与安装接口，生产浏览器开放安装。安装、卸载、更新与启停操作
在返回成功前确认持久化，Cube 走现有状态归档，Docker 使用原有用户命名卷。
保存失败可在通知里“重试保存”，不会重新安装；不确定结果需先刷新检查，不自动重放写请求。
已确认保存的技能文件、安装记录和启停配置支持换代恢复，当前会话的提示词不变，新会话生效。
实现与边界见 [云端技能市场迁移](docs/cloud-skill-market-migration.md)。

## 新会话专属文件夹

生产浏览器复用桌面会话创建流程：未主动选择目录的新会话，在实例工作区下创建
`YYYYMMDD-HHmmss` 文件夹（按实例时钟命名），同一秒冲突追加数字后缀，并创建 `.tmp` 中间文件目录。
日常办公、学习生活按原有规则使用新目录；代码开发继承项目目录，用户明确选择的目录保持不变。
档案默认目录不是实例工作区时不自动创建；创建失败沿用原会话目录，不阻止发送。

文件夹位于用户持久化工作区，经现有状态归档随实例升级恢复。会话创建失败时只清理当前转发器
创建且仍为空（或仅含空 `.tmp`）的目录，不递归删除；有文件、路径被替换、转发器重启后均保留。
接口复用实例会话鉴权和排空限制，无需 MaaS token 或新增 PG 表。

上线需同时更新前端和实例模板，执行 `deploy.sh all --branch cloud-adaptation`。
验证新会话首次发送后的 cwd、显式选择项目目录，以及并发新会话的目录是否独立。

## 云端连接器（第一批）

推荐连接器页面开放高德、有道云笔记、WPS、企业微信和腾讯 ima 知识库，支持配置、工具调用、停用、重新启用和断开。
有道和高德填写 API Key，WPS 填写 Agent API Key，ima 填写 Client ID 与 API Key；企业微信工具连接器
手动填写 Bot ID 与 Secret，复用桌面智能机器人 API/MCP 协议，不建立消息平台的长连接。
其他 Provider、OAuth/扫码、专家与多 Profile 尚未开放；沃邮箱继续使用“我的邮箱”的原有授权和 MCP。

OpenConnector 按需运行在用户实例内，一个实例一个服务，仅监听回环地址。入口通过登录会话
校验和固定 `/__entry/connectors` 接口管理，不需要 MaaS token，也不复用同事的共享连接器容器。
数据库、加密密钥和受管 MCP 配置随现有用户状态归档，恢复时更新内部地址；停用在每次 MCP
请求处检查，已建立的旧会话也无法绕过。新配置的工具在新会话使用，不强制重载现有会话。

依赖由 `build-frontend.sh` 按连接器锁文件安装并缓存，打包产物进入实例镜像；用户实例不执行 npm 安装。
部署执行 `bash deploy.sh all --branch cloud-adaptation`，需同时更新前端、入口和实例模板，无新增环境变量或 PG 表。

验收：在推荐页连接高德 → 新会话查询天气 → 停用后确认旧会话调用失败 → 重新启用 → 实例重建后再次查询 → 断开。
设置变更只有检查点确认后才报告保存成功；持久化未确认时先查询状态，详情中的“保存”仅重试当前状态归档，不重复连接、解绑或工具调用。
实例工具调用期间参与忙碌判断并阻止排空；服务异常退出只恢复服务，不自动重放上次调用。
Provider 返回的原文件通过实例内限时签名链接交给 Agent 下载，不能把回环地址当作用户浏览器的下载地址；
文件与签名按用户隔离，链接有效期一小时，单文件最多 20 MiB。
本地已验证真实服务、五个 Provider 的 MCP 调用、A→B→A 用户隔离和状态恢复；真实第三方账号仍需部署后验收。

## 云端邮箱

“我的邮箱”复用桌面页面和沃邮箱协议，支持开通/停用、邮件列表、搜索、详情、已读、删除及附件下载。
发送、回复和转发通过新会话中的 `Agent-Mail` MCP 完成；停用会拦截旧会话调用。
授权和启停状态随实例归档恢复，发送限额直接保存在账号工作区卷；无需把 MaaS token 交给实例。
本轮不包含暂停期间的后台实时收信推送，恢复后再查询邮件。
部署需同时更新入口、前端和实例模板，具体边界及验收见 [云端邮箱迁移](docs/cloud-mail-migration.md)。


## 云端消息平台

5G、钉钉、飞书、微信、企业微信复用桌面页面；账号申请、机器人权限与渠道连接步骤，
直接查看各渠道卡片中的“配置指南”。以下仅说明云端部署和排查。

### 启用常驻接入服务

消息由常驻 `channels` 服务接收并写入 PG，再经入口唤醒用户实例执行；关闭网页不影响收件。
入口启动时自动执行 `009_messaging.sql`，使用 `messaging_bindings`、`messaging_inbox`、
`messaging_outbox` 三张表，无需手工建表。凭据加密保存；实例执行回执随已有状态归档恢复。

在 `deploy/hermes-mt/entry.env` 中配置：

```dotenv
MT_BACKEND=cube
MT_PG_LOCK=1
MT_CHANNELS_RELAY_URL=ws://192.168.212.116:18081/hermes/__entry/messaging/relay
MT_CHANNELS_KEY=<现场生成并保存的随机密钥>
```

`MT_CHANNELS_RELAY_URL` 填所有沙箱计算节点可达的入口地址，HTTPS 部署改为 `wss://`。
`MT_CHANNELS_GATEWAY_ORIGINS` 是可选网关白名单，留空时使用可信登录响应或中心下发的地址。
`MT_CHANNELS_KEY` 用于内部通信，只生成一次，入口和 channels 共用，不要在更新时重新生成。
可在部署目录执行下列命令，补齐缺失的密钥且不打印其内容：

```bash
python3 - <<'PYKEY'
import os, secrets
from pathlib import Path
p = Path('entry.env')
lines = p.read_text().splitlines()
if not any(line.startswith('MT_CHANNELS_KEY=') and line.split('=', 1)[1].strip() for line in lines):
    lines = [line for line in lines if not line.startswith('MT_CHANNELS_KEY=')]
    lines.append('MT_CHANNELS_KEY=' + secrets.token_hex(32))
    p.write_text('\n'.join(lines) + '\n')
    os.chmod(p, 0o600)
PYKEY
```

执行 `bash deploy.sh all --branch cloud-adaptation`，同时更新前端、入口、channels 与实例模板。
未配置密钥时不启动 channels。5G 可重新短信登录获取 cloud 凭据并自动绑定，也可由中心下发；
“已保存”不代表连接成功，应确认页面实际显示已连接。同一个机器人应只由一个接入方连接。

### 中心下发 5G 绑定

目标 `user_id` 必须已在 Hermes 登录建立用户记录，且账号未停用；不存在的用户返回 404，不会由该接口创建登录会话。无需新增数据库表。

- `PUT /api/channels/uniagentgate/cloud-binding/{user_id}`：原子保存 5G 凭据和模型配置，自动启用绑定，channels 下一轮调度建立连接。
- `GET /api/channels/uniagentgate/cloud-binding/{user_id}`：返回 `bound`、`state`、`last_error`、`updated_at`，不返回地址或密钥。
- `DELETE /api/channels/uniagentgate/cloud-binding/{user_id}`：解除该用户 5G 绑定，重复调用仍成功；其他平台和模型凭据保持原有配置。

以上是 nginx 对外路径，同时支持 `/hermes/api/channels/uniagentgate/cloud-binding/{user_id}`。沿用 UniClaw cloud-vm-dev 的调用方式，不要求额外服务密钥或浏览器 cookie；接口的访问范围由部署网络或网关控制。中心服务直接提交请求体即可。

部署只需沿用 `MT_CHANNELS_KEY` 和 `MT_CHANNELS_RELAY_URL`。前者用于入口、channels 与实例之间的内部认证，不需要提供给调用 cloud-binding 的中心服务；后者填写所有沙箱节点可达的入口 WebSocket 地址。`MT_CHANNELS_GATEWAY_ORIGINS` 可留空，网关地址来自登录响应或下发请求。

PUT 请求体沿用 UniClaw 结构：

```json
{
  "uniagentgate": {
    "gateway_url": "https://uag.example.com",
    "agent_id": "cloud-agent-user-id",
    "agent_sk": "由中心服务提供的云端 Agent SK"
  },
  "my_plan": {
    "apiKey": "sk-用户模型凭据",
    "models": "{\"models\":[{\"id\":\"main\",\"model\":\"model-name\",\"base_url\":\"https://model.example.com/plan/v1\",\"provider\":\"yuanjing\"}],\"main_model_id\":\"main\"}"
  }
}
```

`my_plan` 沿用 Hermes 当前用户级模型凭据：`apiKey` 必填并以 `sk-` 开头，`models` 是含非空模型数组的 JSON 字符串。网关与模型凭据在同一事务中保存并加密；校验失败或机器人已属于其他用户时，不会部分覆盖配置。模型配置在实例下一次唤醒或访问时沿用已有同步链路生效，不中断当前 Agent 对话。

相同 5G 凭据重试 PUT 只同步模型配置，不改变连接 revision，也不取消正在执行的任务。变更 5G 凭据会轮换 revision，旧连接在 channels 调度时关闭，旧执行按原有 uncertain/cancelled 规则处理。`ok=true` 只表示保存和启用成功，必须继续 GET 确认 state 为 running。该功能只作用于云端入口和集中接入服务。

### 排查与验收

```bash
docker ps -a --filter name=hermes-mt --format 'table {{.Names}}\t{{.Status}}'
docker logs --tail 100 hermes-mt-channels
docker logs --tail 100 hermes-mt-entry
```

实例执行日志在该实例的 `logs/cloud-messaging.log`。排查时核对绑定连接状态、入口能否唤醒实例、
实例能否连到 relay；避免公开业务日志。5G 媒体链接还要求网关能访问 relay 地址对应的 HTTP(S) 主机。
共用沙箱集群时，未确认资源归属隔离前不要执行 `purge-old` 或 `purge-templates`。

部署后逐个平台验证文字、图片、音频、文件进入实例，以及生成附件返回原聊天。
再验证关闭网页后收发、实例休眠唤醒、重启恢复、重复事件不重复执行、用户隔离、解绑停止接收。
真实账号收发尚待验收，本地协议测试及镜像构建不能替代此项。

媒体上限为单文件 20 MiB、单消息/执行合计 25 MiB，图片/视频最多 10 MiB；平台更小的限制仍适用。
图片识别和语音转写还依赖对应模型配置。微信音频返回文件附件；企微 AMR 且不超过 2 MiB
可原生发送语音，其他音频返回文件。企微回复受原连接与 330 秒窗口限制，冷启动或排队可能耗尽窗口。

飞书和钉钉群消息需 @ 机器人。微信群事件默认关闭，仅处理允许列表中的群；iLink 通常不投递
普通微信群消息，代码适配群事件不等于普通微信群可用。

未收到发送确认的消息标为 `unknown`，工具执行中崩溃标为 `uncertain`，不会自动重发或重跑，
需核对原会话后再决定操作。单用户按顺序执行，当前使用单个活动接入服务。
