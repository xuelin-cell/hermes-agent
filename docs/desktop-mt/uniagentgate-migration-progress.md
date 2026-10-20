# uniAgentGate 迁移进度

日期：2026-10-19。范围：协议适配器、个人登录自动绑定、账号网关启动、附件和媒体、单平台重连。来源为 UniClaw `uniwork_release@ce575e5c`，本次不迁入 UniBot。

最新人工验证：2026-10-19 用户确认，个人登录自动绑定、基本文本上行及回复已实际跑通。以下剩余清单按旧版实现对照，不把待验收或新增能力混作尚未迁移。

侧栏补齐：桌面消息来源登记新增 `uniagentgate`，显示名为 `5G 消息`，复用微信等平台的独立分组、折叠、分页及图标机制。普通会话查询排除该来源，消息平台查询保留该来源，已有历史无需迁移数据库，刷新列表即可归组。钉钉、飞书、企业微信原本就在同一来源登记中，有会话后显示各自分组。本次只调整桌面端，不改 Hermes Python 核心或消息路由。

## 0.2.2：my-plan 绑定运行中更新

`LoginSession.queryPlan()` 解析成功的个人绑定后，通过主进程回调写入当前账号的配置和 scoped `.env`，再用该账号的私有 loopback 控制通道发出 `apply_binding`。不向 Renderer 返回凭据，不重启整个消息网关或其他平台。启动前没有运行上下文时仍由账号准备流程统一写入。

插件比较网关地址、Agent ID 和 SK：相同绑定保持原连接；发生变化时仅替换 5G 连接；显式 `uniagentgate: null` 停止 5G。缺字段、坏字段、上游业务错误不会撤销现有绑定。5G 的执行任务、待处理消息及文字缓冲未排空时先延后更新，旧任务完成并使用旧连接回复后才切换；延后期间多次更新以最新落盘内容为准，不保证正在等待审批的任务会立即结束。

此功能消费现有登录/套餐查询结果，不新增定时轮询或服务端推送。当前进程必须已加载支持此操作的插件并建立过账号控制入口；旧进程、控制入口缺失或网关未运行时保存绑定并输出需要重启/检查状态的主进程日志，不通过重启网关强行接管。首次升级本功能需完整退出应用（含托盘）后重新启动。撤销后同一进程仍可再次绑定。

验证：桌面真实登录响应解析、账号配置与 socket 通知 A→B→A，及登录会话回归共 13 项通过；Python 真实 HTTP/WS 协议与媒体回归 8 项通过，覆盖仅 SK 轮换、同凭据不重复注册、旧轮次先回复后切换、撤销/恢复与其他平台对象保持不变。完整 TypeScript 检查通过。一次全量回归出现媒体测试本地服务退出超时，复核全量 8 项通过；运营商端运行中凭据轮换仍待实际验收。

## 0.2.1：重连与卡片修正

只读诊断发现实际账号仍安装 0.1.0 插件，缺少 `control.py` 和 `uniagentgate-control.json`；页面热更新不会更新运行中的 Electron preload、主进程或账号插件。旧版本不再笼统提示重连失败，而是明确提示完整退出应用（含托盘）后重启。启动安装的回归验证旧插件文件会被新版覆盖，不通过重复启动网关尝试升级已运行的插件。

按钮与 UniClaw 对齐：只在停止/错误状态提供重连，在线、连接中及自动恢复时显示禁用的解绑；服务端在线时也不会重复注册。移除 RCS 的打开日志按钮和凭据保存说明，改用指定的配置指南链接。

本次验证：单平台真实 HTTP/WS 重连回归 1 项、桌面控制/插件升级 5 项、消息页 18 项、翻译完整性 20 项通过；完整 TypeScript 检查、定向 ESLint/Ruff 及 diff 检查通过。没有重启或重连用户正在使用的网关；实际账号须完整重启应用后加载新版组件。

## 第二阶段：附件、媒体与单平台重连

2026-10-19 源码实现完成，本阶段尚未做运营商端媒体真机验收。

- **附件上行**：解析全部 `file_url` 输入，流式下载，复用 Hermes 标准图片/音频/视频/文档缓存及 `MessageEvent.media_urls/media_types`；纯附件也触发 Agent，图文在同一轮输入，单附件失败不丢弃有效文字和其它附件。纯附件全部下载失败时下发失败提示。
- **文件和媒体下行**：复用本轮 `MEDIA:`、图片 URL 及受控本地文件提取；通过所属 Profile 的现有 MCP 注册器调用 `get_oss_upload_url`，PUT 字节，兼容内联下载地址与 `confirm_oss_upload`。不新建 MCP 连接、不扫描整个工作区。默认服务为账号内置 `UniAI-Toolkit`，可在平台 YAML 的 `upload_server` 指定其它已配置的同协议服务。
- **旧版格式规则**：JPG/JPEG/PNG、AMR/MP3/M4A、MP4/WEBM 走原生媒体，WAV 转 MP3；PDF/Office/GIF 等走下载链接。原生媒体上限 20 MiB，超限跳过；当前单文件下载/读取上限为 64 MiB。某个文件读取、转码或上传失败时，其它文件及最终文字仍可下发。
- **一次最终投递**：适配器延后最终文字，附件阶段将本轮文字、链接与 `media[]` 合并成一次 `channel.message.send`，沿用 Hermes 最终投递结果与账本。直接发送工具的文件/图片/音频/视频入口也接入同一上传规则。跨进程恢复媒体及回复上下文仍不在本轮范围。
- **转码依赖**：优先用 `hermes_platform` 解析系统 FFmpeg；没有时由 PM 准备 `imageio-ffmpeg>=0.6,<0.8` 的独立工具环境。首次 WAV 回复可能需要下载依赖，不修改 Hermes 主 Python 环境；转码进程使用隐藏窗口及所属 Profile 的子进程环境。
- **重连**：主进程固定到当前账号默认 Home，经插件的本机私有控制通道恢复已停止/失败的 5G 连接。其它平台对象不变；正在处理消息或下载附件时拒绝中断，已在线、连接中或自动恢复时不重复注册；接管停止后可人工恢复。新版插件的控制通道不可达时可通过现有账号启动器启动网关，原生启动仍不强制接管活跃网关；账号仍安装旧插件时明确提示完整重启应用。命名 Profile 不回退操作默认账号，仍待多 Agent 阶段设计。

验证：标准 Python runner 的协议、附件、真实 HTTP/WS、真实 MCP/OSS、A→B→A 和重连回归共 **8 项通过**，其中 WAV 用 PM 准备的真实 FFmpeg 转码并核对 MP3 字节；另以独立 Home 验证无系统 FFmpeg 时的 PM 完整转码路径。Windows 真实 `gateway run` 启动及重复启动不接管 **1 项通过**。桌面控制/绑定/启动定向 **5 项通过**，消息页及翻译完整性 **37 项通过**；TypeScript、Ruff、修改文件 ESLint 定向检查通过。没有向生产号码发送短信或调用付费模型。

生效与验收：修改源码后须完整退出并重新启动应用，账号插件资源在启动时更新。先发一张图片或 PDF 验证纯附件上行，再要求生成图片、文档及音频验证回传，最后点击“重连”检查状态恢复。文件回传依赖当前账号的 OSS MCP 服务可用；仅有 5G 个人凭据不代表 OSS 可上传。手机最终收信和运营商审核仍需人工确认。

以下保留第一阶段的实现和排障记录；功能现状以本节及末尾剩余清单为准。

## 已实现

| 环节 | 当前实现 |
| --- | --- |
| 协议插件 | 发行包 `assets/uniagentgate-plugin`，安装进当前账号 Home 的 `plugins/uniagentgate`，通过 `register_platform` 加载；未新增核心模型工具或修改 Hermes 网关核心 |
| 注册与长连接 | 原 register/heartbeat/WS 协议、请求头、短期 token、首帧握手、WS 心跳、瞬断退避、4004 过期重注册、4003 接管停止、三轮鉴权恢复上限 |
| 基本文本收发 | `agent.request` → `MessageEvent/build_source/handle_message` → Hermes 普通回复 → `channel.message.send`；原消息的 session/turn 上下文随 message ID 关联，保留链接 URL |
| 确认与停止 | 入站 ACK 和内存去重；下行业务 ACK；ACK 超时/结果不确定时禁止通用重试和纯文本 fallback 再次计费；断开时清理分发任务、待确认 Future 和回复上下文 |
| 登录绑定 | 主进程消费 `data.plan.ipUrl/agentIdPersonal/agentKeyPersonal`；my-plan 兼容 nested `uniagentgate`；绑定解析独立于模型目录，模型查询失败仍能保存登录绑定 |
| 绑定更新 | 缺失/错误字段保留最后可用绑定；显式 nested null 停用并清 secret；模型空套餐不自动撤销 5G；重新登录时相同账号复用 Home 并可更新 SK |
| 凭据与授权 | 地址、ID 及行为进入账号 `config.yaml`；SK 写账号 `.env`，不送 Renderer；只消费 personal 字段。个人 Agent 的归属由注册鉴权、WS 首帧与消息 Agent ID 验证，使用 Hermes 现有上游鉴权委托，不把 `sa_…` 标识误当手机号匹配白名单 |
| 账号隔离 | 插件发现、secret reader、锁和任务使用所属 Home；连接资源按网关地址+Agent ID 锁定，SK 轮换不改变锁身份 |
| 启动接入 | 账号准备后安装插件；桌面运行时就绪且尚未退出时，使用原解释器、账号 Home/工作区启动原生 `gateway run`，不安装服务、不强制接管；现有账号退出/恢复事务负责清理所属网关 |
| 默认显示策略 | 配置关闭文本流、工具进度、普通中间回复、长任务通知、typing 和网关重启提示；保留必要交互路径，完整通道行为仍待后续回归 |

网关进程创建成功不表示 5G 已连接。运行状态由原 `gateway_state.json` 及现有平台状态接口提供。进程启动输出在账号 Home 的 `logs/desktop-gateway-launch.log`；插件连接日志走现有网关日志。

2026-10-19 后续修复：Windows 不再以 Node `detached: true` 直接启动 Python；短生命周期的隐藏启动器复用 Hermes 的 `windows_detach_flags()`，为网关创建隐藏控制台和独立进程组，受 Job 限制时仅对 `PermissionError` 使用原生无 breakaway 降级。启动器结束后网关继续运行，账号退出清理规则不变。启动器启动失败会回报失败，不把启动器的 `spawn` 事件当作网关已创建。

桌面 RCS 卡片已接入现有平台状态接口：停止/错误时显示重连，在线及连接中显示禁用的解绑；提供[配置指南](https://docs.qq.com/doc/DZmdiTERIT2VjZHJB)，不显示凭据说明或打开日志按钮。未发现插件时明确显示组件不可用。不会向页面新增传递 SK，也不提供覆盖登录凭据的手动配置表单。

本次修复验证：桌面消息页与翻译目录 37 项通过，启动与绑定定向 4 项通过（包含真实 Windows 隐藏控制台测试：实际 Python 及未设置隐藏选项的子进程均无可见控制台，启动器退出后子进程仍存活）；完整 TypeScript 检查通过。真实账号日志在本次只读诊断中显示注册成功和 WebSocket 连接成功，这只能证明该次连接，不代替运营商短信收发验收。

绑定是在启动准备时生效。本轮没有实现运行中的套餐推送及凭据热轮换，也没有把配置写入成功显示为在线。

## 已连接但没有回复时的诊断

“已连接”表示注册及 WebSocket 握手成功，不保证运营商上行已经交给 Agent。2026-10-19 补充接收与回复诊断：账号 `logs/gateway.log` 中的 `uniAgentGate` 行使用消息摘要 `ref` 关联，不新增记录正文、完整手机号或上游原始消息标识。

| 日志 | 能确认的环节 |
| --- | --- |
| `inbound received` | WebSocket 已收到 `agent.request`；尚未保证字段有效或已授权 |
| `inbound queued` | Agent ID、消息 ID 检查通过，已安排本地分发 |
| `dispatch to Hermes` | 当前已鉴权连接的文字消息已交给 Hermes 原有授权与处理流程；不等于模型已完成 |
| `reply sending` | 正在下发回复 |
| `reply accepted` | 下发收到网关业务 ACK；不代表运营商已送达手机 |
| `inbound ignored` / `reply blocked` / `reply unconfirmed` | 查看同一 `ref` 的原因码；未确认下发仍不会自动重发 |

忽略原因包括消息 ID 缺失、Agent ID 不匹配、回调不属于当前已鉴权连接、空文字／纯附件和不支持的协议帧。已移除迁移时额外增加的大陆 11 位手机号正则校验。随后真实来信显示外部会话标识为 `sa_…`，须按原 UniClaw 的个人 Agent 连接归属授权：适配器通过 Hermes 的 `authorization_is_upstream` 委托，且仅在自身已认证连接运行时生效；不影响其他平台或全局权限。登录准备不再自动生成手机号白名单，也不再因恢复记录缺少手机号而禁用有效绑定。回复保留原消息的发送者标识及 session/turn 上下文。

安装中的插件在下次完整账号启动时从发行资源更新；修改源码后须完整退出再启动，页面刷新不会重载已有网关进程。若没有新的 `inbound received`，应结合发送时间检查运营商／网关上游的上行路由与投递记录，不能仅凭客户端连接状态判定手机消息已到达。

本次诊断增量按 `scripts/run_tests.sh` 通过 3 项真实本地 HTTP/WebSocket 测试，覆盖 A→B→A、收发确认、各类丢弃原因与新增日志脱敏；未替用户向生产号码发送消息或调用模型。

移除额外手机号校验后，同一测试文件共 5 项通过。新增用例先在修改前复现 `invalid_phone` 丢弃，再验证带国家码及外部会话标识可进入 Hermes 接入流程，且回复保留原发送者标识、session 和 turn；模型由本地测试 handler 替代，未冒充真实短信收发验收。

授权适配修复将该回归接入真实 `GatewayAuthorizationMixin._is_user_authorized`，先复现旧实现返回 False，再验证已认证连接可处理 `sa_…` 标识、其他平台仍拒绝，连接前及断开后撤销该委托。HTTP/WebSocket 回归 5 项、登录准备回归 4 项通过；后续用户已确认基本文本收发及自动绑定跑通。

## 验证记录与边界

- Python 按 `scripts/run_tests.sh` 执行，最终协议及授权回归共 5 项通过。使用本地 ASGI 假网关、真实插件发现/配置读取/scoped secret、真实 BasePlatformAdapter 文本投递及 Hermes 授权检查；覆盖双 Home A→B→A、缺 secret 不借用启动账号、重复来信、业务 ACK、HTTP 心跳失败、鉴权恢复、会话过期、接管终止及 ACK 超时不重发。模型响应由测试 handler 提供。
- 登录/套餐/账号准备/secret 合并/网关启动的七个 TypeScript 定向文件共 21 项曾全部通过。补充 IPC 回归后的最后一次普通沙箱运行有 22 项通过，原有 `.env` junction 验证因 Windows 沙箱 `EPERM` 失败；同项在此前允许执行的测试中通过。
- 桌面完整 TypeScript 检查通过（包含网关启动前的账号退出检查）。Ruff 和修改文件的 ESLint 进行定向检查。
- Windows 原生实进程测试 `tests/apps/desktop/test_uniagentgate_startup.py` 已补跑通过：独立 Home、用户根、锁及工作区启动实际 `gateway run`，等待真实插件连接，再次启动保持原 PID 和连接不变，最后回收本测试的 launcher/worker 子树。使用项目为刻意实进程测试提供的 `live_system_guard_bypass` 标记，不修改守卫或操作用户网关。
- 早期测试曾受自动审批容量及 Git Bash 沙箱权限阻断，第二阶段已补齐上述本地回归；这些历史阻断不再作为当前未验证理由。
- 基本文本及自动绑定已获用户人工确认；连续来信、长任务、故障恢复、运营商媒体审核及完整安装包真机验收仍待进行。自动化回归没有向生产号码发短信或调用付费模型。

复跑时使用项目 PM 准备的含 dev/test 的独立解释器，设置 `HERMES_PYTHON` 后运行：

```text
scripts/run_tests.sh tests/apps/desktop/test_uniagentgate.py tests/apps/desktop/test_uniagentgate_startup.py --file-retries 0
```

桌面在 `apps/desktop` 运行：

```text
npx vitest run --project electron electron/entry_local/uniagentgate-control.test.ts electron/entry_local/uniagentgate-config.test.ts electron/entry_local/start-messaging-gateway.test.ts electron/login/session.test.ts electron/login/plan.test.ts electron/login/ipc.test.ts electron/entry_local/model-key.test.ts electron/entry_local/prepare-account.test.ts electron/entry_local/runtime-context.test.ts
npm run typecheck
```

## 仍需迁移

| 项目 | 旧版能力与新版差距 | 建议顺序 |
| --- | --- | --- |
| 忙碌处理策略 | 用户已接受当前任务不被普通来信打断、后续来信允许合并；可复用 Hermes `queue`，不再要求严格逐条 FIFO。本次绑定更新未修改 Profile 的忙碌模式配置 | 配置选择 |
| 启动状态展示 | 刚启动时网关已存在但平台尚未发布状态，会短暂显示“需要重启”；推送未触发时需重新进入页面才能刷新。已定位，尚未修复 | 体验修正 |

对照入口：旧版 `channels/runtime.py` 的 `_handle_uniagentgate_message`、`_stage_uniagentgate_attachment`、`_build_uniagentgate_media`、`retry_uniagentgate`、`_reload_uniagentgate_locked` 及对应多 Agent 方法；新版 `assets/uniagentgate-plugin/adapter.py`、`electron/entry_local/uniagentgate-config.ts` 和消息平台页面。

## 已实现能力的待验收项

- 连续多条消息、长工具任务、异常及审批/澄清回复，验证不串 session/turn、不重复下发，明确控制类回复的计费行为。
- 真实断网恢复、token 过期、4003 接管停止、账号 A→B→A 及退出清理；协议自动化已覆盖相应分支，仍需完整桌面场景验收。
- 完整安装包在干净机器上的插件安装、运行依赖和启动验证。构建配置已包含 `assets/**`，缺的是发行包验证，不是尚未添加插件资源打包规则。
- 媒体链路本地实现及回归已完成，仍需测试手机号的运营商端实际收发及格式、大小、失败场景验收。

## 不属于旧版迁移欠账的扩展

产品范围已确认为每个登录账号下发一组个人 5G 凭据并绑定默认助手。多 Agent 的独立绑定和 Profile 路由不属于本次必做迁移项；只有未来需要多个独立 5G 入口时再设计。

持久化去重、进程崩溃后回复上下文恢复、套餐服务主动推送、送达/已读回执、交互式 RCS 卡片等不能据此列为旧版已有但未迁移的功能；若需要应另行定义范围。旧版内存去重同样不承诺跨进程恰好一次，业务 ACK 也不等于手机送达。手动填写 SK 的配置表单不是个人登录自动绑定的必要迁移项。UniBot 与云端 Agent 凭据不在本轮个人 5G 迁移范围。

当前基础个人文本链路已获用户确认；完整旧版功能对齐及发行验收仍有上述剩余工作。
