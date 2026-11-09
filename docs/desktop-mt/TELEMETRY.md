# 桌面版数据埋点与本地自测

桌面实现基于 `release`，最近一次同步基线为 `53a1762a62`。接口沿用《客户端能力调用上报接口 v3》和《客户端对话轮次事件接入说明 v3》。启用策略：**默认开启，包含本轮输入摘要**。

## 实现位置

- `apps/desktop/assets/usage-telemetry-plugin/`：独立 Python 插件；观察轮次、API、工具、子代理和审批，归集事件、SQLite 持久化及重试。
- `apps/desktop/electron/uniwork-telemetry/`：主进程账号桥接、套餐快照和输入关联。访问 Token 仅留在 Electron，插件只持本机桥接凭据。
- 桌面发送入口记录会话、请求哈希与可见输入；插件实际开始执行时才匹配。不会把展开的技能正文、系统提示、历史或附件正文作为输入摘要上报。
- 欢迎标签随本次发送固定真实目录 ID；请求被接受后通过现有 `command.dispatch` 通知插件，复用插件队列，不给 `prompt.submit` 增加协议字段。
- 打包脚本把插件放入 `dist/python-plugins/uniwork-telemetry`；后端启动时按 Profile 启用，尊重已有停用设置。

Hermes 的 `agent/`、`tools/`、`tui_gateway/`、`hermes_cli/`、插件框架及 `run_agent.py` 均未修改，无 monkey patch。

## 已接入的行为

| 项目 | 当前行为 |
| --- | --- |
| 普通/专家办公对话 | 桌面提交与实际执行关联后采集；成功且有回答才报轮次，失败/取消不报完成 |
| 时间及输入 | 开始时固定 `occurredAt`；单调计时，扣除可观察审批等待的并集；摘要清理后最多 2000 个码点 |
| 中断续跑 | 精确绑定来源执行；已闭合的执行段恢复同一业务轮次并累计有效时间。缺来源或缺完整计时则跳过完成事件，隐藏系统说明不作为输入摘要 |
| 模型和套餐 | 保留 my-plan 的真实套餐和展示名；主模型原始 usage 只读采集，重试的每次实际调用分别计入；只映射已确认的托管配置 |
| 子代理 | 继承父轮，模型按各自身份归集；父轮冻结后不回填迟到用量 |
| 技能 | `skill_view` 成功返回正文才计数，参考文件和重复加载短响应不计；从套件索引、市场来源和内置清单恢复身份 |
| MCP | 已确认身份的连接器、内置 UniAI 工具箱、插件组件和公共服务成功时计数；保留业务错误识别，未知身份跳过 |
| 标签 | 欢迎目录的真实标签 ID，以请求被接受为时点；仅选择/填入模板或发送失败不报，后续回答失败不撤销 |
| 插件 | 同轮首次成功组件触发 1 次插件使用，明细共享 `usageId`；专家按实际执行轮次计数 |
| 队列 | 每 Profile 独立 SQLite，按账号/应用/环境分区；事件冻结，每批最多 50 条且 ≤256 KiB；最多保留 29 天/10000 条 |
| 回执 | HTTP 200 且 `code=200` 后按 index 校验全部回执，再处理 accepted/duplicate/rejected；413 拆批、429 退避、401/403 暂停 |

`usages` 没有合法套餐身份时省略；没有真实消费来源时不填 `usedYuanZhu`。原始 JSON 经主进程直接转发，int64 不经 JavaScript 重编码。

## 本地启动与检查

在仓库根目录打开 PowerShell：

```powershell
npm.cmd run dev --workspace apps/desktop
```

命令会启动 Vite 和 **UniWork 的 Electron 桌面窗口**。请在自动弹出的窗口中登录和聊天，保持终端运行；无需先安装正式发行版。日志中的 `http://127.0.0.1:5174/` 是桌面界面的开发资源地址，普通浏览器没有 Electron 注入的 `window.hermesDesktop`，直接打开会显示 `Desktop IPC bridge is unavailable.`。

关闭登录窗口（未完成登录交接时）会正常退出 Electron，`concurrently -k` 随后停止 Vite，因此终端可能以 npm code 1 结束。这种组合退出不等于 Python 后端崩溃。仓库另有 Hermes Web Dashboard，但它不包含当前桌面版的账号及埋点桥接，不能替代本次桌面链路自测。

开发环境需要工作区 Node 依赖、Electron 运行时和连接器依赖，并通过 Hermes PM 准备 Python 环境。登录后启动的是当前源码，Python 插件修改后需完整退出并重启桌面。

### 已修复的 Windows 启动权限问题

2026-11-06 的 `did not find executable at ...hermes-telemetry-tools...python.exe` 来自基础 Python 目录的 NTFS 权限：工具账户可运行，但实际桌面登录账户无法读取、执行。已仅为本机登录账户补充该运行时目录的读取、执行权限，未修改内核或账号数据。

修复后已在实际 Windows 登录账户下验证 `.venv` 的 Python 与依赖导入，以及隔离 `hermes serve` 的 READY、HTTP 健康检查、带认证的 WebSocket `session.list` 和 `commands.catalog`（含 `usage-report`）。测试后台已关闭；这不是生产对话或上报验证。后续准备开发环境时，不能仅凭工具账户中的测试通过就判断桌面账户也能运行。

聊天框执行以下插件命令，不会调用模型：

```text
/usage-report status
/usage-report flush
/usage-report off
/usage-report on
```

- `status` 查看 `enabled`、内存队列、SQLite pending/sent/rejected、最近发送状态、丢弃数和覆盖缺口。
- `bridge: true` 只表示取得启动时的桥接信息；连接失败时，`bridgeError` 给出失败路由、异常类型及可取得的 HTTP 状态，不输出 Token、本机路径或异常原文。
- `flush` 唤醒发送器；正常自动发送间隔 60 秒，累计 50 个观察信号也会唤醒。它不绕过退避、认证暂停或格式错误暂停。
- 开关按当前 Profile 保存在 `plugins.entries.uniwork-telemetry.settings.enabled`，专家 Profile 独立生效。
- 队列在当前 Profile 的 `plugin-data/uniwork-telemetry/data.db`。`events` 表保留 `id/payload/state/error`，可用 eventId 与服务端核对；不保存用户 Token。
- 同一数据库的 `turn_journal` 保存业务轮次、原始输入摘要、已闭合执行段的累计时长及已确认用量；按账号隔离，保留最多 29 天/10000 条。轮次检查点与上报事件在同一事务内写入。
- 使用既有正式接口 `https://maas.ai-yuanjing.com/app/gateway/analytics/events/batch`，不会自动切到测试环境或借用其他账号。

建议依次自测：纯文本成功对话 → 选择标签并发送 → 取消/失败 → 实际加载技能 → 工具箱生图/已连接 MCP → 专家和子代理 → 断网积压/恢复 → 切换账号。每步先查看状态，再核对服务端事件。重新生成属于新请求；摘要无法从重建提示中可靠恢复时省略。

### 2026-11-09：桥接不可用已复现并修复

Windows 上 Hermes 会把插件 Home 路径转成小写，原桥接校验却区分了路径字母大小写，将同一目录误判为账号目录之外，导致 `/context`、`/input` 返回 HTTP 502。随后显示 `bridge_unavailable`、`input_correlation_unavailable` 和 `unbound_desktop_request`，本地没有生成事件。

桥接现在按 Windows 路径规则校验并统一输入关联的目录身份；账号边界和 Profile 停用规则仍保留。同步新版 release 时也接入了启动前批量准备、运行中新建 Profile 两条插件启用路径，并保留新版标题桥接。

已先复现修复前的 HTTP 502，再验证真实 Python 插件与桌面桥接之间的 Agent 执行、输入关联、SQLite 入队及逐项回执，状态达到 `delivery: 200`、`events.sent: 1`、无关联缺口；实际 Windows 登录账户下同一测试也通过。模型与上报服务均为本地测试服务，未代替生产验收。

复测需完整退出并重启桌面，发送一条新的普通办公消息，回答完成后执行 `/usage-report flush`，稍后查看 `/usage-report status`。预期 `bridgeError: null`、`delivery: 200` 且 `events.sent` 增加。此前被跳过的轮次没有入队，不会自动补报。

### 2026-11-09：标签与内置工具箱漏报修复

原实现未把欢迎页的标签选择传入发送链路；内置 `UniAI-Toolkit` 也缺少旧业务 ID，因身份未知被跳过。基础上报通道正常并不代表这两个场景已经接入。

- 标签：界面固定本次选择的目录 ID/名称，`prompt.submit` 成功后用原生插件命令通知采集器。按提交标识生成稳定 `eventId`，重复通知、网络重试不重复计数；清除标签或切换草稿不沿用旧选择。
- 工具箱：桌面受管配置保留旧版 ID `ea53ce61-be39-4c44-aa4a-732df43842cc`（`uniwork_builtin_id`）；插件的 `post_tool_call` 将其映射为 `subject.id=builtin:ea53ce61-be39-4c44-aa4a-732df43842cc`，工具名保留为 `txt2img_generate` 等实际调用名。不改 Hermes 内核。
- 验证：真实 ChatBar 选择/发送测试，以及真实插件命令、Agent 的 `tool_call`、本机 MCP 服务、SQLite、桌面桥接和逐项回执。得到标签、工具箱、连接器、会话各 1 条事件；失败工具、停用时的标签及重复通知未增加计数。模型与上报服务均为本地模拟，尚需生产自测。

完整退出桌面和旧开发进程后重新启动，分别重测标签发送及工具箱生图，再执行 `/usage-report flush`。服务端应查询 `capability.invoke` 下的 `subject.type=skill_tag` 和 `subject.type=mcp`；此前跳过的事件不会自动补报。

### 中断续跑的统计口径

桌面把新用户请求、显式续跑和其他隐藏系统消息分开标记，元数据仅走埋点桥接，不增加 Hermes RPC 字段。续跑按钮保留原执行标识；该标识来自 Profile、会话及原生开始标记的进程/时间身份，不按相似文本或“最近一轮”猜测。采集开始时还校验标记的进程及提交时间窗口，拒绝旧标记和迟到读取的新标记。

- **可恢复**：来源执行已收到并保存中断结束事件，计时、等待区间及子代理结束边界完整。重新打开进程后恢复原业务 `turnId`、`occurredAt`、原始输入和累计用量；例如 20 秒执行、等待重启、再执行 15 秒，只上报同一轮的 35000 毫秒。
- **不完整**：来源只留下 `running` 检查点，或计时/等待边界缺失。续跑仍可执行，但不会上报 `conversation.turn.completed`。已确定的业务归属可以保留，用于成功能力调用的去重；不完整状态不会因后续再中断、再续跑而变回完整。
- **无来源**：没有持久化检查点、旧版本记录没有执行标识、来源已完成或被新用户请求替代时，不创建新的统计轮次。重新生成或用户重新执行仍是新轮次。
- **输入与用量**：隐藏系统说明不进入 `userInput`；中断 API 没有返回用量时，相关累计字段保持未知并省略，不把部分计数当完整总量。原生执行 ID 可变化，业务 `turnId` 和插件 `usageId` 保持不变；实际工具调用按各自执行及调用 ID 去重。

`coverageGaps.resume_state_unavailable` 表示没有可绑定的来源；`resume_incomplete` 表示来源可绑定但统计不完整；`hidden_request_skipped` 表示其他隐藏系统发送被排除。旧版本已丢失的计时信息不能补造。此修复不新增续跑按钮，也不改变模型的续跑行为。

本地验证包括真实 Agent 中断、独立 Python 进程重启、主动 `os._exit` 模拟崩溃、A→B→A Profile 切换及本机桥接上报；远端模型/MCP/上报服务由本地夹具提供，不能替代生产验收。

## 当前明确未等价覆盖的部分

这些是客户端覆盖边界，不需要服务端重新建设接口，也不通过改内核绕过：

1. **后台 MCP 提交**：新版先创建子代理，缺少旧版“具体 MCP 已接受提交”的结构化事实；翻译、播客和视频后台调用暂跳过并记录缺口，不改在最终完成时计数。
2. **不可恢复的续执行**：已支持带明确来源且统计完整的续跑。没有结束边界的崩溃、旧版本无检查点的记录，以及未携带显式来源的自动/隐藏续执行仍跳过完成统计；不会将片段当作完整新轮。
3. **部分输入/入口**：发送入口、会话和请求哈希必须唯一匹配；排队超时、提示被后端改写、旧会话缺路由或其他未接入入口会显示 `unbound_desktop_request`，该请求暂不采集。不会上传可能错误关联的摘要。
4. **部分用量/暂停**：辅助流式 usage、未知凭证或套餐不补零；澄清工具等缺完整等待区间时不报该轮耗时。当前审批 hook 不涵盖所有原生交互等待。
5. **能力身份**：未关联到工具事件的斜杠技能加载、缺推荐/市场来源的技能、缺旧配置业务 ID 的其他内置或自建 MCP、被截短的 MCP 工具名暂不报。不会用 URL、哈希或猜测的 ID 代替旧业务 ID。
6. **代码执行器**：日常办公与学习生活共用普通执行链；代码开发的 `codex_app_server` 执行统计尚未完整接入，公共标签发送链路独立于它。当前协议不按页签单独分类上报。

因此这是可以自测的桌面实现，尚不能宣称旧版全部场景等价迁移；云版未改动。

## 验证记录

- Python 11 项测试通过，覆盖原有协议与队列，以及跨进程轮次恢复、累计用量、重复回调、不可恢复片段跳过和检查点/完成事件的原子写入。
- 通过真实插件发现、hook/middleware、SQLite、A→B→A Profile 切换及实际 `AIAgent.run_conversation` 执行链。模型和上报端为本地测试服务，**不是生产联调**。
- 本次 Electron 相关 32 项测试通过，覆盖受管工具箱配置、桥接、输入关联、完整 MCP/标签链路，以及真实 Agent 中断后跨进程恢复和崩溃片段跳过；Electron 类型检查和开发包构建通过。
- 相关 UI 测试 234 项通过、1 项失败，覆盖标签、续跑来源，以及同步后的图片重发、检查点恢复、附件菜单和粘贴流程。失败项为上游新建会话测试：新版标题会截短，但测试回调仍断言完整原文。在隔离工作区中干净的 `release@5edd5e6e57` 也复现同一失败，未扩大本次修复范围。
- 全量前端类型检查有 34 条诊断，位于本次未修改的连接器文案及 i18n、侧栏、定时任务、会话列表测试、邮件和主题测试；与隔离工作区中干净的 `release@5edd5e6e57` 诊断完全一致，后续同步 `53a1762a62` 后仍一致。未扩大本次修改范围。

Python 验证命令（Git Bash）：

```bash
HERMES_PYTHON="$PWD/.venv/Scripts/python.exe" scripts/run_tests.sh tests/plugins/test_uniwork_telemetry.py -q --tb=short
```
