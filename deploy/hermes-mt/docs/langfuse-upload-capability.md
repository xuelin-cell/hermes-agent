# Langfuse 上传专用凭证

本次提供 Entry 按用户缓存 JWT、签发与校验长期上传凭证、实例引导时自动配置插件，以及 OTLP HTTP 转发能力。每个用户只有一份上传凭证，不设置或校验凭证有效期。保留现有 Langfuse 插件的采集与批量上传逻辑，不修改插件、不新增脱敏。部署者明确配置实例可达的 Entry 地址后，才为引导的用户实例启用采集；默认关闭。

```text
实例 Langfuse SDK -- Basic(专用 public_key:secret_key) --> Entry
Entry -- Bearer(该用户当前缓存的 MaaS JWT) --> 原有鉴权网关 --> Langfuse
```

## 配置与签发

上游追踪网关固定在代码中，不支持环境变量或调用方覆盖。Entry 在固定根地址后拼接 `/api/public/otel/v1/traces`。

沿用 UniClaw `cloud-vm-dev` 的已确认地址 `https://www.yjworker.10010.com/langfuse`。旧实现的 `libs/hexagent_demo/backend/hexagent_api/observability/langfuse.py` 的 `_base_url()` 同样固定返回该地址，并使用 `/api/public/otel/v1/traces`，因此新链路复用原上传路径，无需因本次接入新增 Nginx 路径规则。

设置 `MT_LANGFUSE_ENTRY_URL` 为**用户实例可达的 Entry origin**，例如 `https://entry.example.com`，不包含 `/hermes` 或其他路径；Entry 自动追加部署 `base_path` 和 `/__entry/langfuse`。未配置这个地址时，采集和转发均关闭。Docker 实例处于独立租户网络，必须确认 Entry 在该网络的 DNS 名称；不能把浏览器自己的 localhost 当作实例可达地址。Cube 推荐使用可达的 HTTPS 地址。

自动接入不需要浏览器调用签发接口：Entry 在实例引导时直接向 Store 获取对应用户原有凭证，仅把内部 key 和上传地址写入实例 `.env`。MaaS JWT 不进入实例。

已登录浏览器可调用现有 `requestEntryMaas(basePath, 'langfuse/grant')`，即 `POST /hermes/__entry/langfuse/grant`。请求必须同时携带 Entry 会话 cookie、JWT 绑定证明 cookie 和 MaaS Bearer token；仅有 JWT 或实例 token 都不能获取凭证。首次创建，此后重复调用或并发请求均返回该用户原有凭证，不轮换。

响应为：

```json
{
  "public_key": "pk-lf-<随机标识>",
  "secret_key": "sk-lf-<随机上传凭证>",
  "base_path": "/hermes/__entry/langfuse"
}
```

这两个 key 是 Entry 专用的凭据对，不是 Langfuse 项目 AK/SK。迁移 `010_langfuse_credentials.sql` 为用户维护一条持久记录，`user_id` 为主键，`public_key` 唯一；secret 用现有部署主密钥认证加密存储，另存摘要供上传校验，不存明文。已验证的用户可以重新取得相同凭证，Entry 重启、实例重建和 JWT 更新不要求换 key。用户 JWT 仍只保存在 Entry 内存中，不写入 PG，也不返回给实例。

## Entry JWT 缓存

启用追踪转发后，短信登录成功时 Entry 直接缓存上游返回的 JWT；后续分享、网盘、`maas-auth` 等请求通过既有 cookie/JWT 绑定校验时，也会更新缓存。没有配置实例可达的 Entry 地址时，不额外留存追踪 JWT。

缓存按 `user_id` 隔离，每个用户只保存一份最近从可信登录或绑定校验取得的 JWT；同一账号任一端提供新 JWT 会更新这份缓存，不影响其他用户。上传凭证仅关联用户，不关联网页登录会话，也不保存 JWT 快照；每次后台转发重新读取该用户当前缓存的 JWT。JWT 更新无需重新签发上传凭证或重建 SDK client。未经绑定校验的请求和用户实例提供的 JWT 不会写入缓存。

浏览器关闭、断网、退出或 Entry 浏览器会话到期不会清除用户的后台上传授权，5G/定时任务可以在 JWT 有效时继续使用长期凭证上传。登录时保存 MaaS 返回的 JWT 期限，不因网页会话提前到期而缩短；通过浏览器绑定校验取得的 JWT 使用证明中的已验证期限，同一 JWT 已有更长期限时不缩短。JWT 更新不是向 MaaS 自动续签；JWT 到期或 Entry 重启后仍需重新取得 JWT，但不需要重新下发实例凭证。没有取得过该用户 JWT 的 5G 开通流程仍不能凭空生成 MaaS JWT。

JWT 缓存有最多 1024 个用户的进程内上限；新增授权超过上限时跳过追踪缓存，不影响正常登录或其他已验证业务，获取上传凭证会报告授权容量不足。过期 JWT 缓存由请求及定时清理释放，停止 Entry 时清空 JWT 缓存；持久上传凭证不受这些清理影响。后台上传还检查用户账号是否 active，账号停用时拒绝但不删除凭证，恢复后可继续使用；账号记录被真正删除时，对应凭证随外键删除。

## 实例配置

Entry 复用现有配置分发通道：Cube 的 bootstrap 在启动 Hermes 前以 `upsert-lines` 合并 `.env`，以 `patch-model` 合并 `plugins.enabled`；Docker 通过已有 archive 配置通道合并 `.env` 和配置，发生变化时按现有生命周期逻辑重启容器。保留其他插件、用户自行配置的 key 和插件显式禁用项。

下发 `HERMES_LANGFUSE_PUBLIC_KEY`、`HERMES_LANGFUSE_SECRET_KEY`、`HERMES_LANGFUSE_BASE_URL`，并加入 `plugins.enabled: [observability/langfuse]`。云端使用插件现有 `HERMES_LANGFUSE_CAPTURE=full` 模式，不增加额外脱敏；插件仍有自身的内容长度和深度限制。

云端 `Dockerfile.cube` 通过 PM 安装已锁定的 `langfuse` extra，并将现有插件加入 overlay；`Dockerfile.cube-new` 继承此镜像。未使用云端镜像的 Docker 部署也必须准备该 extra。未改动项目依赖版本或插件源码。

**已有 Cube 实例必须通过新模板替换、重新引导后生效**。快路径不会热改正在执行任务的实例；不能只更新 Entry 就认为所有存量实例已开启。默认 profile 之外的新 profile 仍需要按 Hermes 的 profile 隔离规则单独启用、配置插件。本次不新增页面开关或跨 profile 配置继承。

该用户的凭证稳定不变，正常 JWT 更新或 Entry 重启恢复 JWT 缓存不需要重建 SDK client。若由运维主动修改数据库中的凭证，则还需同步实例配置；本次不增加轮换或撤销接口。清空 `MT_LANGFUSE_ENTRY_URL` 可停止自动配置和 Entry 转发，已写入实例的插件条目不会自动删除。

## 权限与生命周期

- 只允许 `POST <base_path>/api/public/otel/v1/traces`，认证兼容未修改 SDK 的 HTTP Basic。不能查询项目、读取 trace、上传媒体或访问其他 Entry 业务接口。SDK 的 `auth_check()` 不适用于这个仅上传入口。
- 上传凭证没有有效期字段，也不进行凭证时间校验；已移除 `MT_LANGFUSE_GRANT_TTL_S`。每次上传在 PG 中验证凭据对并取得用户，再检查账号状态及该用户缓存 JWT 的期限；长期凭证不代表 JWT 永不过期。
- 同一用户重复获取返回原凭证，不会让旧的客户端失效；网页退出、实例替换、Entry 重启和 JWT 更新都不轮换上传凭证，不提供独立的 HTTP 撤销接口。
- Entry 重启后凭证仍有效，但 JWT 缓存为空时拒绝转发；登录或 `maas-auth` 等绑定校验恢复缓存后，已有实例自动使用原凭证继续上传。凭证在 PG 中共享，JWT 缓存仍是进程内的，当前部署按单 Entry 进程使用，不承诺多副本 JWT 同步。
- 专用凭证确认用户实例的上传权限；JWT 的签名、上游撤销和权限仍由原网关检查。网关返回 401/403 仅表示本次上传失败，不撤销 Entry 专用凭证；上游恢复后可继续使用原凭证上传。
- 每次收到上传才转发，不新增离线队列。最多 4 路同时转发，解压后请求体最大 16 MiB，单次上游请求超时 10 秒，不跟随重定向，不把上游错误正文、cookie 或实例自带的任意认证头继续透传。SDK 的重试会再次经过全部校验。
- 专用凭证不授予上游其他业务权限，但其持有者可以提交追踪数据；它不证明上报内容一定来自真实执行，也不会自动将 payload 中的用户字段改成可信身份。

## 上线前还要确认的边界

- 复用原 Nginx 已有的 `POST /langfuse/api/public/otel/v1/traces` 链路，完成 Bearer JWT 校验后覆盖为真实 Langfuse 项目的 Basic AK/SK。旧 UniClaw 与本次插件使用同一个 OTLP 路径，不需要新增放行规则。Entry 保留 SDK 的 ingestion-version/version 协议头，支持压缩请求解码转发。
- SDK 批量队列不是持久消息队列。JWT 缺失或过期、上游故障、进程强杀时不能承诺零丢失，也不会在恢复登录后补传已经丢弃的数据。沿用插件的 finalize/flush/shutdown，不额外开发落盘重传；若要求可靠补传，需另立需求。
- 上传鉴权能识别平台用户，不等于 Langfuse 页面自动具有平台 `user_id` 维度。现有插件主要记录 Hermes session、task、turn 等字段；本次不修改追踪 payload 来增加或强制可信用户标签，也不提供项目内的数据可见性隔离。
- 当前 JWT 缓存仅适用于单 Entry 进程；多副本需要共享缓存或按用户稳定路由。无需网页登录的 5G 用户若从未取得 MaaS JWT，仍不能上传。长期内部凭证没有改变这些授权前提。

## 验证

`tests/hermes_mt/test_langfuse_upload.py` 通过真实 Entry HTTP 路由、合成登录绑定和本地 TLS 上游验证登录即缓存、同账号各端共享当前 JWT、不同用户隔离、后台无 cookie 上传、全部网页退出后仍可上传、账号停用/恢复、JWT 过期、清理后凭证复用、重复获取不轮换、缓存更新/恢复与失败请求不能污染缓存，以及 A→B→A、混用凭证、gzip 正文和错误响应。另用真实 Langfuse SDK 上传并解析最终 OTLP protobuf，验证父子观察关系和认证头替换。数据库回归覆盖迁移、同用户并发获取、密文/摘要存储、不同用户隔离和重连后的凭证复用；需要测试 PostgreSQL。

运行 `scripts/run_tests.sh tests/hermes_mt/test_langfuse_upload.py tests/hermes_mt/test_browser_auth.py tests/hermes_mt/test_forward_seed.py`。实例引导测试通过真实种子落盘和插件发现，验证 A→B→A 凭证隔离、保留用户配置、重复配置幂等；上传测试调用实际插件 hooks 和 SDK 后解析最终 OTLP。数据库回归需要测试 PostgreSQL。

本地测试不等于已部署：上线仍须验证镜像构建、实际实例网络可达、原网关 JWT 校验和 Langfuse 入库。服务器地址和凭据通过实际部署环境配置，不填入仓库。
