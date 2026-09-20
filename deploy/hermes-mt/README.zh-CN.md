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
```

## 目录

| 路径 | 作用 |
|---|---|
| `compose.yaml` | 常驻两个服务：`nginx`、`entry`。租户容器**不在 compose 里**，由入口按需起 |
| `entry/` | 入口服务（Python 3.13 + aiohttp，单进程）。`entry/entry/*.py` 见文件头注释 |
| `seed/forward.py` | 放进每个租户卷 `/opt/data/.mt/` 的 TCP 转发器（标准库，30 行） |
| `seed/config.yaml.tmpl` | 每个租户首次建卷时写入的 `config.yaml` 模板 |
| `nginx/hermes-mt.conf` | 由 `.7` 单用户版的 Nginx 配置改来：两处 `proxy_pass` 指向入口，去掉写死的 token，静态加 `auth_request`，并用 `sub_filter` 注入角标 |
| `entry/entry/static/badge.js` | 注入 SPA 的角标（谁在登录 + 退出），不碰前端产物 |
| `scripts/build-frontend.sh` | 构建浏览器版前端到 `nginx/dist-browser/`（与 `deploy-custom-web.sh` 同一条 vite 命令） |
| `scripts/verify_isolation.sh` | 验收 27 项：登录门禁 / 两个用户各自的世界 / 网络围栏 / 文件链路与文件隔离 |
| `scripts/verify_ws_keepalive.py` | 回归：ws 静默挂着时容器不被空闲回收停掉 |
| `entry.env.example` | 入口的环境变量样例；复制成 `entry.env`（已 gitignore） |

## 前置条件

- docker ≥ 20.10、docker compose v2；宿主能跑 `hermes-custom:dev`（`.7` 上已验证：CentOS 7 / 3.10 内核 / docker 26.1.4）。
- 镜像 `hermes-custom:dev` 已存在（`.7` 上就是现网那个），或按 `docs/custom-web-docker-deployment.zh-CN.md` 构建。
- 浏览器版前端产物：`bash deploy/hermes-mt/scripts/build-frontend.sh`；或直接复制现网 release：
  `cp -a /mnt/hermes-runtime/hermes/. deploy/hermes-mt/nginx/dist-browser/`（注意末尾 `/.`）。
- 与单用户版**并存**：端口默认 `18081`（单用户版是 `18080`），容器名前缀 `hermes-mt-` / `hermes-t-`，互不冲突。

## 部署

```bash
cd deploy/hermes-mt
cp entry.env.example entry.env          # 生产：MT_DEV_LOGIN=0；其余按需
bash scripts/build-frontend.sh          # 或复制现网 release，见上
docker compose -p hermes-mt up -d --build
curl -s http://127.0.0.1:18081/hermes/__entry/health   # {"ok": true, "tenants": []}
```

浏览器打开 `http://<host>:18081/hermes/` → 被带到登录页 → 手机号 + 图形验证码 + 短信验证码 → 登录成功后入口
后台拉起该用户的容器（首次十几秒），页面进入聊天界面。

**谁在登录 / 退出**：页面右下角有一小块角标，显示当前账号（短信登录显示打码手机号，
鼠标悬停看完整用户 id）和「退出」。点退出即回登录页；也可以直接访问 `<base>/logout`。
★ 这块角标由 Nginx 的 `sub_filter` 往 index.html 注入一行 `<script>` 实现，
**前端源码与构建产物一个字节不动**——SPA 是 hermes 原生的，界面上不会有任何跟我们
登录体系相关的元素。脚本本体是入口的 `/__entry/badge.js`，只往 body 末尾加自己的节点。
位置贴着最底部状态栏那一行右端：再往上就会压住输入框右侧那排按钮（实测过）。

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
拿这个用户自己的模型 key，写进他的卷（`.env` 的 `HERMES_CUSTOM_YUANJING_API_KEY`），
**并用 my-plan 同时下发的 `base_url` / 模型名写他的 `config.yaml`**。
★★ 套餐 key **只在 my-plan 给的那个「TokenPlan 专用路径」上有效**：打手写的通用网关地址会被回
`{"code":1004,"msg":"当前请求路径错误，请使用 TokenPlan 专用路径发起请求"}`。`MT_MODEL_BASE_URL`
只是 my-plan 没给 base_url 时的兜底，正常路径上不该用到它（用到了会打 WARNING）。
上游给的 base_url 少末尾 `/v1`，入口自动补。
★ **套餐里的全部模型都要写进 `providers.<key>.models`**：界面的模型下拉读的是这个映射，不是
`default_model`；只写主模型，用户就只看得到一个（实测套餐有 3 个模型时只显示 1 个）。
端点或模型清单任一变化都会触发同步（`.mt/endpoint.stamp` 记的是两者）。JWT 不验签、不解码，只信
登录那一跳；入口自己签不透明的 cookie，有效期不超过上游给的 `expiresAt`。**没套餐 = 没 key**，不会拿平台的 key 兜底。

## 运行与维护

| 事 | 怎么做 |
|---|---|
| 看有哪些租户在跑 | `docker ps --filter label=hermes.mt=tenant`；或 `curl :18081/hermes/__entry/health` |
| 某用户的 hermes 日志 | `docker logs hermes-t-<uid>`；卷内 `logs/`：`docker run --rm -v hermes-data-<uid>:/d alpine ls /d/logs` |
| 入口日志 | `docker logs hermes-mt-entry`（每条带 userid） |
| 空闲回收 | 入口每分钟扫一次：**只要还挂着 ws 连接就绝不回收**；没有连接且 `MT_IDLE_MINUTES`（默认 30）内无活动才 `docker stop`，**卷不动**，下次请求再起 |
| 入口重启 / 机器重启 | 入口**先开始监听，再在后台**把所有租户容器 stop、状态清零，之后按需再起（租户容器 `restart=no`）。实测重启后 1.5s 内可服务 |
| 停/删某个用户 | `docker rm -f hermes-t-<uid>`（数据仍在卷里）；彻底删除再 `docker volume rm hermes-data-<uid>`、`docker network rm hermes-net-<uid>` |
| 备份某个用户 | `docker run --rm -v hermes-data-<uid>:/d -v $PWD:/out alpine tar -C /d -czf /out/<uid>.tgz .`（在线备份 state.db 用 `sqlite3 .backup` 更稳） |
| 升级 hermes 镜像 | 构建新镜像 → 改 `entry.env` 的 `MT_IMAGE` → `docker compose -p hermes-mt up -d entry`。入口发现容器镜像不同会**删容器重建，卷不动** |
| 升级前端 | 重新 `build-frontend.sh` → `docker compose -p hermes-mt up -d --build nginx` |
| 换模型/网关 | `entry.env` 的 `MT_MODEL*`，只影响**之后新建**的卷；老用户的 `config.yaml` 属于他自己 |

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

## 已知限制（V1 待办）

1. 模型 key 只在**首次建卷**时写入 `.env`；用户续费换了 key 要手动改卷里的 `.env` 并重启容器（hermes 启动时读一次）。
2. `hermes serve` 模式**不跑定时任务**（cron ticker 只在 `HERMES_DESKTOP=1` 时启动）。
3. 入口的服务面状态目前是 SQLite（卷 `hermes-mt-state`），表结构按 users / sessions / tenant_runtime / audit 设计，
   后续换 PostgreSQL 只改 `entry/entry/store.py`。**不存对话**，对话永远在各用户卷上。
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
- `entry.env` 不进 git；模型 key 只在内存和用户卷里，入口不落库、不打日志。
