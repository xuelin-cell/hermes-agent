# 本机联调用的假统一登录网关

只在开发机上用，不上任何服务器。照《统一登录方案》v2.3 做了云端用到的几个接口，用来在本机把入口的统一登录（`MT_SSO=1`，见 `entry/entry/sso.py`）从头走到尾：

| 文件 | 是什么 |
|---|---|
| `gateway.py` | 登录页 `/login/`（不发短信，列出测试账号点一个就登录）、`/validate`、`/sso/me`、`/sso/logout`、12.4，以及给个人版用的假 my-plan |
| `nginx.conf` | 网关 nginx：`/agents/` 这一段和 `docs/企业版对接/37` 给登录系统的参考配置相同，只有 `Host` 用 `$http_host` |
| `accounts.example.json` | 测试账号和假套餐的格式；复制一份填上本机平台的企业 ID、成员 ID |

## 起

前提：本机企业版栈（`127.0.0.1:18091`）和个人版栈（`127.0.0.1:18092`）的入口都开了 `MT_SSO=1`；企业版还要本机平台（带 `/api/internal/sso/device-token`）。

```bash
# 1. 假网关（宿主机上跑，只依赖 aiohttp）
python gateway.py --accounts <你的 accounts.json> --host 127.0.0.1 --port 18096

# 2. 网关 nginx（容器里经 host.docker.internal 访问宿主机）
docker create --name sso-dev-gateway -p 127.0.0.1:18095:8080 nginx:1.27-alpine
docker cp nginx.conf sso-dev-gateway:/etc/nginx/nginx.conf
docker start sso-dev-gateway
```

浏览器打开 `http://127.0.0.1:18095/agents/`。

## 入口这边要配的（entry.env）

| 变量 | 企业版 | 个人版 |
|---|---|---|
| `MT_SSO` | `1` | `1` |
| `MT_SSO_TRUSTED` | 网关 nginx 进来时的来源地址 | 同左 |
| `MT_UNIWORK_INTERNAL_TOKEN` | 和本机平台的 `UNIWORK_CLOUD_INTERNAL_TOKEN` 相同 | — |
| `MT_SSO_CREDENTIAL_URL` | — | `http://host.docker.internal:18096/app/gateway/sso/internal/maas-credential` |
| `MT_SSO_CREDENTIAL_TOKEN` | — | 和 accounts.json 的 `credentialToken` 相同 |
| `MT_MYPLAN_URL` | — | `http://host.docker.internal:18096/fake/my-plan` |

`MT_SSO_TRUSTED` 一开始不知道填什么：先随便填一个，用网关登录后访问一次，入口日志里会有 `sso: identity headers from <地址> ignored`，把这个地址填进去重启入口。Docker Desktop 上一般是该栈 Docker 网络的网关地址。

## 坑

- 网关转发时 `Host` 必须带端口（`$http_host`）。用 `$host` 的话端口没了，站点不在默认端口上时，入口拿浏览器的 `Origin` 比对会对不上，写请求和 WebSocket 全被当成跨站拒掉（入口日志：`refused cross-origin`）。
- 本机 Docker 的 172.17～31 网段被各实例网络占满时，新网络会分到 192.168.x，和办公网段重叠。新建的栈在 compose 里写死网段（比如 `10.213.0.0/24`）。
