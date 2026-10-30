# .7 同机独立部署

原 `deploy.sh`、`compose.yaml` 保持原用途；新增环境只使用 `deploy-isolated.sh`。
新脚本加载原脚本的构建函数，再替换资源命名、配置加载、Compose 调用、模板名称及状态查询；不会运行旧脚本入口。
原脚本最后的入口结构变化时，新脚本会停止，需检查兼容性。

## 新建空白环境

先把目标分支放到独立 checkout，例如 `/mnt/hermes-adaptation-src`。
不要在现有 `/mnt/hermes-mt-src` 里切分支部署第二套；前端产物、构建缓存及 entry.env 都是目录级状态。

在新 checkout 的 `deploy/hermes-mt` 下执行（替换实际内网 IP 和控制面、数据面地址）：

```bash
bash deploy-isolated.sh init \
  --project hermes-adaptation \
  --http-port 192.168.1.7:18082 \
  --cube-api http://CONTROL_PLANE:3000 \
  --cube-proxy http://DATA_PLANE
bash deploy-isolated.sh check
bash deploy-isolated.sh all --branch cloud-adaptation
bash deploy-isolated.sh status
bash deploy-isolated.sh log
```

`init` 生成当前目录的 `entry.env`，权限 600，已被 `.gitignore` 忽略，不提交 Git。
已有文件时拒绝覆盖；真实密钥不应进入版本控制或部署日志。
两套环境的项目名、页面 IP:端口、MT_PREFIX、MT_COOKIE 必须各不相同。
项目名一旦开始使用便不要改动，否则会指向不同的数据库卷。

新部署的容器、网络、数据库卷和服务镜像使用项目名前缀；沙箱镜像仓库为
`hermes-isolated/<项目名>-cube`。PostgreSQL 只在各自 Docker 网络内开放，
不发布宿主机端口，原有 `MT_POSTGRES_PORT` 配置不生效。
推镜像临时端口默认 15001（旧脚本默认 15000）；如果被其他部署占用，
在 entry.env 设置另一个 `MT_DEPLOY_FWD_PORT`。不修改 Docker daemon 或默认构建器。

日志、历史和运行状态使用 `.isolated-*` 文件；其余构建产物由各自 checkout 隔离。
基础镜像仍沿用原脚本的源码内容指纹，可复用相同内容的基础镜像。
同机两套环境仍共享 CPU、内存和磁盘容量，构建建议错峰。

## 从 .116 保留数据迁移

不要使用 `init` 生成的新数据库或新密钥替代旧数据。先备份，再安全复制原 entry.env，
保留 `MT_CREDENTIAL_KEY`、原数据库连接凭据和原 `MT_PREFIX=hermes-116-test`。
在副本中增加或调整：

```dotenv
MT_DEPLOY_PROJECT=hermes-adaptation
MT_HTTP_PORT=192.168.1.7:18082
MT_COOKIE=hermes_adaptation_session
MT_DEPLOY_FWD_PORT=15001
MT_DEPLOY_BRANCH=cloud-adaptation
MT_BACKUP_PREFIX=backups/hermes-adaptation/
```

地址仅为示例。保留原 MT_CUBE_API / MT_CUBE_PROXY 才能访问原集群用户卷。
迁移入口数据库到新部署独立 PostgreSQL（通过 docker exec 导入导出），
并确认归档、用户卷以及模板可用后再切流量。
切换前停止 .116 旧入口和消息渠道，避免两个入口同时管理同一批用户实例。
密钥、数据库、归档和用户卷共同构成迁移数据，仅复制代码不够。
备份前缀改变后旧备份仍在原位置，应保留旧副本并记录恢复路径。

## 共享集群清理与验收

新脚本拒绝 `purge-old` 和 `purge-templates`。
**其他旧部署也必须停用这两条命令**：旧 `purge-old` 仍可选中本环境的实例，
新脚本无法约束旧脚本。不要按旧部署摘要的提示运行批量清理。
`status` 仅通过本部署数据库确认实例归属；模板按本部署镜像仓库路径筛选。
创建模板失败时仍沿用原流程，只删除本次创建失败的模板，不做集群批量清理。

若启用消息渠道，确保渠道账号/云 Agent 只由一套环境接管，
并分别配置可达的 MT_CHANNELS_RELAY_URL、回调及允许来源。

上线后分别登录两套环境，核对用户卷、登录态、文件和对话各自独立；
单独重启新环境，确认旧环境仍能访问。新脚本不会自动迁移或部署到服务器。
