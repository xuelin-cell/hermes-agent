# 云端版本适配清单与分期方案

日期：2026-10-23。代码基线：`release @ 98a50d2eb2`。参考资料：《云版-09-跟上桌面版前端》，其基线为 `218b852fa0`。

本次交付是代码静态核查与实施方案，不包含功能修改或上线。没有连接生产入口、集群或 MaaS 验证；参考资料中的线上版本、唤醒耗时、实例插件状态均不作为已核实事实。下述“已有”表示代码存在，不等于本次端到端测试通过。附录覆盖 bridge 顶层接口；嵌套操作、别名调用和所有页面路径仍需动态验收。

## 1. 当前结论

继续共用 `apps/desktop/src` 页面，在 `src/dev/browser-bridge.ts`、`src/lib/browser-shell.ts`、入口服务和用户实例补齐差异。用户电脑、入口服务器、用户实例是三个不同的执行环境，文件路径和能力不可混用。

当前 `hermesDesktop` 声明有 181 个顶层成员，浏览器桥接有 65 个，缺少 116 个；对象成员按一项计，生产专属 terminal 计入。已有桥接包含空订阅和兼容占位，因此 65 不等于 65 个完整业务功能。不能把 116 项直接当成开发任务：其中很多是原生窗口或安装管理能力。

相较参考文档，新增四项：`agentMail`、`localConnectors`、`onCloudDriveMutationProgress`、`reconnectUniAgentGate`，桥接均未实现。

最重要的变化：首页目录已经要求有效 MaaS 登录身份，配置键从文档中的 `welcome_config_codex_*` 变为 `welcome_config_v3_*`。`electron/uniwork-welcome/client.ts` 会校验语言、身份过期、返回配置和请求期间身份是否变化。首页配置应进入账号能力批次，不能继续按匿名公共配置实现或默认跨用户缓存。

## 2. 功能全景清单

| 功能域 | 当前代码状态与风险 | 适配动作 | 批次 |
|---|---|---|---|
| 登录、账号展示、退出 | 入口登录存在，桥接从 `__entry/me` 读取脱敏账号；MaaS token 在登录阶段用于查询套餐，未传入持久化登录流程 | 回归过期、退出、多标签页与切换账号；明确退出与实例后台工作的关系 | P0/P1 |
| 对话、流式输出、重连 | 使用同源入口和用户实例，浏览器连接声明为 remote | 验证断网、实例暂停唤醒、会话恢复、重复发送与历史完整性 | P0 |
| 模型与配置 | 已有云端模型过滤、默认 profile、登录套餐模型配置路径 | 回归套餐变化、开发者模式、配置刷新；不把桌面进程状态当租户状态 | P0/P1 |
| 工作区文件、附件、回收站 | 虚拟本地附件和实例读写/上传下载/重命名/回收站已有实现 | 文件大小、中文名、同名、权限、跨租户路径与会话恢复验收 | P0 |
| 文件夹选择 | 浏览器以 remote 连接走实例目录；路径含义不同于本机 | 实测定时任务与输入框两个入口；起点用实例工作区，保留合理的实例目录导航 | P0 |
| 终端 | 生产 bridge 接实例 terminal WebSocket，开发模式不提供 | 验证输入、粘贴、resize、断开与退出、账号隔离 | P0 |
| Office/PDF/音视频/HTML 预览 | 已有实例转换、媒体下载与隔离 HTML 路径 | 验证大文件、转换失败、脚本隔离、分页、媒体 range、过期与取消 | P0 |
| 首页模块/分类/模板 | 缺 `getWelcomeCatalog`；桌面现要求 token 和 v3 配置 | 入口按当前会话代调，桥接返回相同契约；校验、超时、版本、失败保留目录 | P1 |
| 消息平台入口 | 缺三项 messaging bridge；状态 store 无条件调用订阅和状态方法 | 按能力阻止未适配页面挂载，涵盖直达 URL 与开发者模式；不要假报操作成功 | P0 |
| 消息平台完整功能 | 桌面调度依赖常驻网关；云端有空闲暂停生命周期 | 选择常驻策略；补凭据验证、机器人归属、操作队列、进度、换代恢复 | P3 |
| UniAgentGate 重连 | 新增可选 `reconnectUniAgentGate`，云端没有 | 纳入消息平台链路确认用途、身份与实例路由；实现前不显示可操作重连入口 | P0/P3 |
| 实时语音输入 | 缺 `uniworkAsr`，composer 仍传入 ASR 控件；hook 给出桌面专属错误 | 首批按能力隐藏；后续接入口长连接代理和浏览器录音 | P0/P4 |
| 套餐用量/订阅 | bridge 缺三项套餐方法，普通模式隐藏面板 | 共用账号凭据基础；用量先做，购买另验状态回流、重复提交和失败反馈 | P1 |
| 会话/回复分享 | 缺 `conversationShare`，普通模式隐藏 | 入口代调、访问控制、有效期、撤销；不暴露源账号凭据 | P2 |
| 产物分享 | 缺 `artifactShare` | 实例文件转分享服务，明确上传完成、权限、过期、撤销和重复发布 | P2 |
| 个人云盘 | 缺请求、传输、取消、进度等接口，浏览器页占位 | 入口保管服务凭据，文件传输明确用户浏览器/实例/云盘三端，含取消和进度事件 | P2 |
| 云盘操作进度 | 新增 `onCloudDriveMutationProgress`，云端没有 | 和上传下载进度分别覆盖移动/删除等变更操作；避免只有请求没有完成状态 | P2 |
| Markdown/PDF/Word 导出 | 缺 `exportPreview`，相关按钮有存在性判断 | Markdown 可浏览器下载；PDF/Word 复用实例转换能力前先核实格式契约 | P2 |
| 新对话专属文件夹 | 缺创建/丢弃接口，存在性判断使其不启用 | 明确实例卷目录、并发创建、会话关联、空目录回收；禁止误删已有内容 | P2 |
| 资料库/交付卡片 | 云端有专属文案与产物适配；镜像实际插件状态未验证 | 先核实镜像和插件清单，再决定元数据、路径检查和交付插件的实例实现 | P2 |
| 智能体邮箱 | 新增 `agentMail`；my-mail 默认启用，云端过滤集没有它；状态请求明确提示仅桌面可用 | 首批检查并封闭不可用入口；后续审计邮箱身份、供应商凭据、操作代理和后台收信需求 | P0/P4 |
| 本地连接器 | 新增 `localConnectors`；推荐连接器 hook 检查 local 模式和接口存在性 | 拆分用户电脑资源和可服务端授权的连接器；后者复用实例/入口能力，前者暂不承诺 | P4 |
| MCP 密钥/授权 | 已有密钥打码与保存还原；无桌面 `mcpOauth` | 保留已有密钥配置；另验 OAuth 回调与云端域名，不能从密钥配置成功推导 OAuth 可用 | P0/P4 |
| 技能市场安装 | browser-shell 返回开发中提示 | 核实实例已有安装 API，补授权、安装状态、失败恢复；保持会话缓存规则 | P4 |
| 套件/专家/Bot Mode | 普通模式过滤 hermes-bots、uniwork-kits | 产品决定是否开放；核实实例资源、profile、多代理与连接器依赖后再启用 | P4 |
| 定时任务 | 入口已有 cron 提前唤醒和暂停逻辑 | 回归关浏览器后执行、时区、重启、迁移和失败重试；不能借此推断消息平台可被动唤醒 | P0/P3 |
| 通知、剪贴板、日志 | 浏览器读写剪贴板已有实现，notify 返回 false，日志部分占位 | 首批确认 UI 不误报可用；通知要浏览器权限，实例诊断需用户级日志端点 | P4 |
| 原生桌面能力 | 窗口/HUD/托盘/桌宠/截屏/透明/快捷入口等无浏览器对应物 | 不复制原生能力；入口、直达路由、快捷键均做一致能力约束 | P0，后续不适配 |
| 安装与设备管理 | 更新/卸载/修复、本机路径、SSH、原生插件、连接配置等 | 由部署体系或实例管理承担；普通用户隐藏不能代替实际权限校验 | P0，后续按需 |
| Git、主题与高级设置 | 多项 desktop bridge 不存在，部分入口通过开发者开关隐藏 | 分辨“暂未实现”和“无对应物”；若要实例 Git，另做实例路径与权限设计 | P0/P4 |

## 3. 分期实施与验收

### P0：建立能安全使用的浏览器基线

范围：消息平台和邮箱等不可用路由、语音按钮、开发者模式暴露的入口；文件夹语义；现有聊天/文件/终端/预览/定时任务回归。

交付：逐项记录“可用、明确不可用、待适配”；能力约束同时作用于菜单、命令面板、直接 URL、快捷键和插件注册。开发者模式可以展示调试信息，不能凭空使缺失方法可用。不要靠成功空实现掩盖未完成业务。

验收：普通和开发者模式均不发生缺失方法导致的页面异常；刷新直达链接仍可恢复；A→B→A 账号切换不串文件、会话或缓存；浏览器构建及核心端到端冒烟通过。现存缺口先在基线上复现，再修改。

### P1：账号凭据与首页配置、套餐读取

依赖决策：是否让入口保存用户 MaaS 登录令牌，保留多久、退出是否撤销以及多设备策略。

推荐按现有 `CredentialCipher` 与 PG 存储路径扩展，不另造凭据管理器。区分 MaaS token、套餐 API key、入口 session、实例 token。服务端从会话确定身份，不接收页面指定的 user_id；token 不返回浏览器。定义过期、重新登录、失效、登出和缓存清理行为。

首页接口只接受固定语言；复用当前 v3 数据契约与版本字段，保留 8 秒有界超时和失败时本地目录。缓存至少绑定用户/授权范围与语言；只有服务端契约确认所有用户完全相同才考虑共享。明确旧会话未保存 token 时如何要求重新登录。

交付顺序：凭据闭环 → 首页目录 → 套餐用量 → 订阅购买。前三项可独立验收。

验收：真实入口请求路径和临时数据库验证登录、过期、注销、A→B→A；页面和日志不泄露 token；目录加载失败不清空已有内容，过期身份不能读其他用户缓存。

### P2：文件、交付与分享

可不等待 P1 的部分：Markdown 导出、目录语义、实例文件夹、现有转换链路验证。

依赖 P1 的部分：分享、个人云盘及其服务端授权。

推荐交付顺序：Markdown 导出 → PDF/Word → 专属目录与资料库/交付 → 会话/产物分享 → 云盘请求、上传下载、变更进度和取消。

验收：真实实例文件读写与转换，中文/大文件/同名/失败；分享过期和撤销即时有效；取消不把半成品标成成功；跨用户或越界路径拒绝。实例暂停/重建后元数据与文件关联可恢复。

### P3：消息平台与常驻生命周期

| 方案 | 优点 | 代价与前提 |
|---|---|---|
| A：有有效机器人绑定的实例保持运行 | 最多复用插件和现有 gateway，适合先交付 | 常驻成本随用户增长；绑定状态需持久化，不能只看瞬时进程是否运行；异常退出仍需恢复 |
| B：独立常驻消息接入服务 | 计算实例可继续暂停 | 需要凭据托管、归属路由、唤醒、排队、去重、回复与故障恢复，开发与运维成本更高 |

建议先评估 A 的容量与预算，再决定是否采用；用户未选择方案前不实现常驻策略。A 不应只修改 `_busy_reason`：还需覆盖长期空闲删除、实例迁移/换代、入口重启恢复、解绑后释放保活，以及短暂故障时的恢复。

两方案共同要求：机器人标识按平台命名空间定义，跨用户唯一约束由数据库保证；冲突处理、幂等操作、进度更新和租户锁复用现有机制。机器人密钥存实例还是入口需明确；不能将桌面本机账号冲突记录直接视为全局记录。

验收：关闭所有网页后仍收发；重复事件不重复执行；跨租户冲突并发绑定被阻止；断线、进程崩溃、实例迁移后恢复；解绑后不再收消息且可回收实例。各平台按实际协议分别实测。

### P4：增强能力，按业务价值逐项进入

语音（HTTPS/麦克风权限、代理、取消、重连、资源释放）、智能体邮箱（身份、读写操作与后台策略）、连接器/OAuth、技能市场、套件专家、通知与诊断。每项先确认是否能复用实例 API，避免把 Electron 主进程整体搬到入口。

P0 → P1 → 依赖身份的 P2 是主线；无身份依赖的文件功能可在 P0 后推进。P3、P4 各自独立立项。当前不报工期：缺少上线范围、人员、真实环境回归结果和服务端协议确认。

## 4. 测试与发布检查

- 前端使用现有 Vitest 行为测试；直接挂载浏览器 bridge 下的页面验证契约，不写读取源代码断言的测试。
- Python 使用 `scripts/run_tests.sh`，关注 `tests/hermes_mt/`；按具体变更选择文件，不为文档改动运行整套测试。
- 入口/数据库/实例变更验证真实导入、HTTP/WS、存储与故障路径；多租户使用两个独立 home/身份做 A→B→A，不只依赖 mock。
- 浏览器构建使用现有 `build:browser` 和 `deploy/hermes-mt/scripts/build-frontend.sh`，检查 `/hermes/` 前缀、静态资源与入口转发一致。
- 上线验收必须记录前端指纹、入口代码版本、实例镜像/模板版本、插件列表，不能只替换前端后宣称全部适配。
- 发布采用小范围用户验证；准备前端/入口/实例版本回退与数据库兼容策略，检查登录和业务凭据兼容。生产部署不包含在本次整理范围。

## 5. 开始实施前需要确定的事项

1. 首发范围是否以 P0 + P1 为目标，还是包含导出/分享/云盘。
2. 入口是否保存 MaaS token；建议同意后明确会话与凭据生命周期。
3. 消息平台先不开放、采用 A，还是投入 B；需要常驻用户量和资源预算。
4. 邮箱、连接器、套件专家是否进入首发；缺省列后续，不以桌面默认开启推导云端也要开启。
5. 测试入口、测试账号、集群模板与部署责任人；没有这些仍可完成本地适配，但不能声称线上验收通过。

## 6. 核查入口

路径相对仓库根目录：

- `apps/desktop/src/global.d.ts`：完整能力声明。
- `apps/desktop/src/dev/browser-bridge.ts`：浏览器实现与占位。
- `apps/desktop/src/lib/browser-shell.ts`：浏览器差异与开发者模式隐藏逻辑。
- `apps/desktop/electron/uniwork-welcome/client.ts`、`catalog.ts`：首页登录要求与当前契约。
- `apps/desktop/src/app/messaging/operation-store.ts`：缺失订阅方法的直接调用点。
- `apps/desktop/src/plugins/my-mail/plugin.tsx`、`api.ts`：邮箱默认启用与桌面桥接依赖。
- `apps/desktop/src/app/capabilities/mcp-mt/use-recommended-connections.ts`：本地连接器可用性判断。
- `apps/desktop/src/app/chat/composer/index.tsx`、`hooks/use-uniwork-asr.ts`：语音入口与缺能力提示。
- `deploy/hermes-mt/entry/entry/app.py`、`maas.py`、`store.py`、`crypto.py`：登录、凭据与入口路由。
- `deploy/hermes-mt/entry/entry/tenants.py`：实例生命周期、定时任务唤醒与回收。

## 附录：顶层接口盘点

以下按当前声明和 bridge 对象的顶层成员静态提取，用作覆盖索引，不是行为测试或上线能力证明。缺少接口也可能通过页面其他路径完成同类功能（如 Office 预览），须结合上表判断。

### 桥接已有（含占位）（65）

- `api`
- `claimAmbientCue`
- `connections`
- `getAgentRoster`
- `getBootProgress`
- `getBootstrapState`
- `getConnection`
- `getConnectionFor`
- `getGatewayWsUrl`
- `getGatewayWsUrlFor`
- `getMaasAccount`
- `getMachineProfile`
- `getOnBattery`
- `getPathForFile`
- `getProfileRoutes`
- `getRecentLogs`
- `glassSupported`
- `logoutMaasAccount`
- `notify`
- `onBackendExit`
- `onBatteryChanged`
- `onBootProgress`
- `onBootstrapEvent`
- `onBrowserPopoutClosed`
- `onClosePreviewRequested`
- `onConnectionApplied`
- `onContextMenuSpellcheck`
- `onDeepLink`
- `onFocusSession`
- `onFoundInPage`
- `onNotificationAction`
- `onNotificationActivate`
- `onOpenFindBarRequested`
- `onOpenFolderRequested`
- `onOpenUpdatesRequested`
- `onPowerResume`
- `onPreviewFileChanged`
- `onPreviewNav`
- `onWindowStateChanged`
- `openExternal`
- `openPreviewInBrowser`
- `profile`
- `readClipboard`
- `readDir`
- `readFileDataUrl`
- `readFileDataUrlForAttach`
- `readFileText`
- `renamePath`
- `reportRendererError`
- `revalidateConnection`
- `revealLogs`
- `saveClipboardImage`
- `saveGatewayFile`
- `saveImageBuffer`
- `saveImageFromUrl`
- `selectPaths`
- `setActiveConnectionRoute`
- `setActiveWork`
- `setKeepAwake`
- `setTranslucency`
- `terminal`
- `touchBackend`
- `translucencySupported`
- `trashPath`
- `writeClipboard`

### 桥接缺少（116）

- `agentMail`
- `agentPluginsRoot`
- `applyConnectionConfig`
- `artifactShare`
- `cancelBootstrap`
- `cancelCloudDriveTransfer`
- `cancelOfficePreview`
- `capturePreview`
- `chatOnboarding`
- `cloud`
- `cloudDriveAgentReady`
- `cloudDriveRequest`
- `cloudDriveTransfer`
- `contextMenuCopyImage`
- `contextMenuEdit`
- `contextMenuGuestAddWord`
- `contextMenuSpellcheck`
- `continueBootstrapLocal`
- `conversationShare`
- `convertOfficePreview`
- `createConversationFolder`
- `dataUrlReadMax`
- `desktopPluginsRoot`
- `discardConversationFolder`
- `exportPreview`
- `fetchLinkTitle`
- `findInPage`
- `getConnectionConfig`
- `getPlanUsage`
- `getPoolLimits`
- `getRemoteDisplayReason`
- `getSecretStorageEncryption`
- `getSyncStatus`
- `getVersion`
- `getWelcomeCatalog`
- `git`
- `gitRoot`
- `guestOnboardingEnabled`
- `hud`
- `hudModifier`
- `installDesktopPlugin`
- `introReveal`
- `localConnectors`
- `localModelsEnabled`
- `localSkin`
- `logLine`
- `logsRoot`
- `mcpOauth`
- `messagingSetup`
- `messagingStatus`
- `minimizeToTray`
- `normalizePreviewTarget`
- `oauthLoginConnectionConfig`
- `oauthLogoutConnectionConfig`
- `onCloudDriveMutationProgress`
- `onCloudDriveProgress`
- `onExternalOpenFailed`
- `onF12Shortcut`
- `onMessagingStatus`
- `onPoolBackendRetiring`
- `openBrowserWindow`
- `openDir`
- `openSessionInTerminal`
- `openSessionWindow`
- `openWindow`
- `petOverlay`
- `prepareOfficePreview`
- `probeConnectionConfig`
- `probeLocalBackend`
- `probePluginRepo`
- `quickEntry`
- `reachPreviewUrl`
- `readPluginSource`
- `readWindowBelow`
- `reconcileDesktopPlugins`
- `reconnectUniAgentGate`
- `recycleBackend`
- `refreshPlanUsage`
- `relaunchApp`
- `removeDesktopPlugin`
- `repairBootstrap`
- `requestMicrophoneAccess`
- `resetBootstrap`
- `resolveFavicon`
- `revealPath`
- `sanitizeWorkspaceCwd`
- `saveConnectionConfig`
- `savePastedText`
- `screenshot`
- `selectSavePath`
- `setDisableF12`
- `setF12ShortcutActive`
- `setNativeTheme`
- `setPoolLimits`
- `setPreviewShortcutActive`
- `setSecretStorageEncryption`
- `setTitleBarTheme`
- `settings`
- `signalDeepLinkReady`
- `skipIntro`
- `sshConfigHosts`
- `sshResolveHost`
- `stopFindInPage`
- `stopPreviewFileWatch`
- `subscribeMaasPlan`
- `testConnectionConfig`
- `themes`
- `uninstall`
- `uniworkAsr`
- `updates`
- `wakeIndicator`
- `watchDirectory`
- `watchPreviewFile`
- `windowControls`
- `writeTextFile`
- `zoom`
