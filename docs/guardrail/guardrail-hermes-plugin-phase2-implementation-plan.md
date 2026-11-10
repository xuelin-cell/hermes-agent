# Hermes `security-guardrail` 第二阶段实施方案

> 执行说明：本文件为待确认计划。用户确认后，使用 executing-plans 工作流逐任务实施；本轮仅更新文档，不启动迁移。

**更新日期** 2026-11-10

**核对的代码版本** Hermes `release-anquan@05b4b81558`，UniClaw `vm-uniwork-dev@c6a66bbf`

**输入计划** [四阶段总计划](guardrail-hermes-plugin-development-plan.md)，以及本会话 2026-11-10 确认的五项要求。总计划用于划分四阶段；第二阶段范围、排除项和完成标准以本文件的最新约定为准。

**目标** 完成迁移范围内 Guardrail 安全能力的 Hermes 插件化适配，保留原判断语义；完成对应工具输入、宿主环境、配置状态和决策执行的基础验证，逐项列明无法等价接入的能力及原因。第三阶段再系统检验实际安全效果、误报漏报和绕过场景，并进行修正。

**架构** 插件内保留独立的操作输入、执行上下文和决策输出边界，由 Hermes 适配器连接宿主；规则模块不引用 Hermes 上下文对象。Hermes 增加通用 `pre_tool_execute` Hook，提供已准备的执行信息并执行阻断或原生审批，插件提供真实策略回调。此阶段只实现 Hermes 宿主，预留未来其他 Agent 实现同样适配边界的入口，不增加通用服务或第二宿主。

**技术基础** Python、原 Guardrail 同步引擎、Hermes 原生目录插件、Hook/PluginContext、原生审批、PM 管理依赖和现有测试入口。

## 1. 范围与开工条件

第二阶段交付一个可安装、可启用的 Hermes 原生目录插件 `security-guardrail`。插件保留本次范围内的 UniClaw Guardrail 规则、决策逻辑、输入转换、检测器、必要配置结构和数据资源。**全量指范围内的安全能力有完整去向，Hermes 存在对应操作的能力完成真实适配；复制源码、导入成功或只通过 write_file 均不足以验收。** 独立检测 API 保留可调用入口即可，不新增自动外发拦截。先在临时 profile 验证基础接入，阶段三系统检验防护效果，阶段四在实际交付客户端验收。

| 阶段 | 退出条件 |
|---|---|
| 一：简单真实插件 | 已完成：插件可加载，真实 write_file 命中目录规则，阻断结果已由桌面测试确认。 |
| 二：全量插件化适配 | 本文件范围内的引擎、资源、适配器和通用 Hook 完成；能力覆盖表闭合；各类对应工具输入与决策执行基础验证通过。 |
| 三：安全能力校验和修正 | 系统测试实际防护、误报漏报、复杂输入及绕过场景，修正规则或适配问题并回归。 |
| 四：应用与交付验收 | 在约定的实际客户端和部署方式中完成业务、安装升级、审批及配置隔离验收。 |

阶段二不能把已知参数改写绕过、错误目标、缺失关键执行信息或决策未执行留给阶段三，再标为“适配完成”。阶段三进一步探查尚未发现的问题。阶段二不承诺所有 OS、远端后端和客户端均已验证，环境范围须逐项写入覆盖表。

- **迁移边界。** UniClaw 当时为「设置 → 安全中心」开发的功能不迁移，包括设置页面、页面专用的规则管理、配置接口及其与护栏的联动，也包括审计日志的采集、异步写入、存储、查询和展示。`harness/guardrail` 内专为该需求编写的代码和测试，在迁移清单中标为「不迁移」。能独立运行的通用护栏规则和判断逻辑按本方案迁移，由 Hermes 插件配置和原生审批流程驱动。
- 在 `release-anquan` 分支的 [plugins/security-guardrail](D:/liantong/projects/python/hermes-agent/plugins/security-guardrail) 开发和验证，按本方案修改或替换现有 Demo。正式插件可独立安装和启用，安装位置为 `<HERMES_HOME>/plugins/security-guardrail/`。目录名、`plugin.yaml` 中的 `name` 和配置里的插件名都用 `security-guardrail`。源码发布位置按总计划安排。阶段二从待交付的目录安装到临时 profile 验收。
- Hermes 能发现现有 Demo，并在执行本地 `write_file` 前调用它的 `pre_tool_call`。现有测试覆盖保护路径、普通路径、已有文件内容不变、Windows 大小写和目录联接（junction）、POSIX 符号链接，以及切换 profile 后配置是否正确。阶段二继续运行这些测试。Demo 的实现、`protected_directory` 配置键、提示文案和版本均可调整，正式行为和配置以本方案及验收要求为准。 [Demo 入口](D:/liantong/projects/python/hermes-agent/plugins/security-guardrail/__init__.py:10) · [现有测试](D:/liantong/projects/python/hermes-agent/tests/plugins/test_security_guardrail.py:64)
- 默认在本机 Windows 上验证，使用临时 `HERMES_HOME`、本地工具后端、临时工作区和保护目录。在能力覆盖表中分别记录 Unix、SSH、容器、Desktop、Gateway 和 cron 的测试结果。
- 原附件记录：用临时 Windows profile 调用真实 `write_file`，直接写保护目录时被拦截，写普通路径时成功；如果另一个 Hook 把普通路径改为保护路径，文件仍然会写入。这项执行链缺口必须复现并在本阶段修复。本轮文档更新未重跑这些测试。

**工作顺序** 固定源清单和能力去向，迁入通用规则和资源，建立 Hermes 适配契约，落地通用执行前 Hook 并接入插件，再按规则涉及的各类工具完成映射、真实调用和审批验证，最后按能力覆盖表验收。见第 8 节执行任务。缺少必需的信息或控制能力时补通用 Hook/ctx 接口，不能删规则、猜测执行环境或添加 Guardrail 专用 core 分支。

## 2. 复制通用护栏代码和资源

- 从 UniClaw `c6a66bbf` 复制通用护栏的规则引擎、规则表、输入转换、检测器和匹配逻辑。保留原规则 ID、判断顺序和适用条件。清单按文件或函数记录来源、迁入位置及对应测试。一个文件同时含通用代码和安全中心专用代码时，按函数或字段标注去留。 [源规则注册表](D:/liantong/projects/python/UniClaw/UniClaw/libs/hexagent/hexagent/harness/guardrail/baseline_rules/registry.py:17)
- 从 `context.py` 中排除专用于审计的 `audit_tool_input`、`PermissionAuditRecord`、`recent_permission_decisions` 和 `audit_failed`，排除对应的 `test_audit_input.py` 以及安全中心的日志写入、存储和查询代码。检测停用操作系统审计服务或删除系统日志的通用规则仍按普通护栏规则迁入。 [审计采集代码](D:/liantong/projects/python/UniClaw/UniClaw/libs/hexagent/hexagent/harness/guardrail/context.py:79) · [系统日志保护规则](D:/liantong/projects/python/UniClaw/UniClaw/libs/hexagent/hexagent/harness/guardrail/detectors/shell/audit.py:82)
- 安全中心逐条设置「允许／询问／拒绝」的实现记为不迁移，包括 `configurable/` 下的 `AskPolicySnapshot` 和对应的 `test_configurable.py`。通用规则 ID、检测条件和 `ASK` 判定保留。
- 复制独立的敏感文本检测函数、规则文件和许可证。通过插件自身的包路径读取 `catalog.json`，在 `plugin.yaml` 的 `python_dependencies` 中声明 Pydantic 2.x（暂定 `pydantic>=2,<3`）。用合成数据验证规则文件能加载、检测结果正确。 [资源加载](D:/liantong/projects/python/UniClaw/UniClaw/libs/hexagent/hexagent/harness/guardrail/sensitive_protection/catalog.py:157) · [检测入口](D:/liantong/projects/python/UniClaw/UniClaw/libs/hexagent/hexagent/harness/guardrail/sensitive_protection/detector.py:82)
- 优先把原始迁入与适配修改分开形成可审阅差异，保留源文件/函数、源提交、SHA-256、规则 ID、资源许可和原测试的对应关系。用等价输入对比迁移前后的判断；除本文件明确的安全中心排除及 ASK 替换行为外，第二阶段不重新设计安全规则。迁移中的意外决策变化必须修复或登记为阻塞。 [UniClaw 许可证](D:/liantong/projects/python/UniClaw/UniClaw/LICENSE) · [BetterLeaks 许可证](D:/liantong/projects/python/UniClaw/UniClaw/libs/hexagent/hexagent/harness/guardrail/sensitive_protection/assets/BETTERLEAKS_LICENSE.txt)

源目录的附件基线盘点为 60 个 Python 文件、2 个敏感检测资源文件、138 条规则和 28 个原测试文件（含目录外 `test_guardrail.py`）。这些数字在任务 1 复核，排除安全中心专用代码后不要求文件数量相同。每个源文件允许按函数/字段拆分，但必须有去向。审计服务的写入和存储不迁移；为验证规则而保存不含敏感原值的测试结果不等于新建审计子系统。

## 3. 在插件里把工具参数交给规则引擎

- 用 `adapters/hermes.py` 把 Hermes 工具参数和实际执行信息转换为原引擎使用的 `RuntimeAction`，由 `evaluate_tool_call()` 调用迁入的同步规则引擎。保留决定、理由和原规则 ID。把原来从 UniClaw 环境变量读取的安装目录等值改为显式参数，保护目录和模式从当前 Hermes profile 的插件配置读取。
- 保留通用 `ASK` 判定。`ASK` 模式直接调用 `check_ask_baseline()`，命中后交给 Hermes 原生审批。硬拒绝优先，`AUTO` 跳过仅需询问的规则。逐条设置「允许／询问／拒绝」仍属于排除范围。 [ASK 规则判断](D:/liantong/projects/python/UniClaw/UniClaw/libs/hexagent/hexagent/harness/guardrail/baseline.py:40)
- **ASK 的明确替换行为。** 原 `engine.py` 仅在传入安全中心 `ask_policy` 时选择 ASK 规则；未配置时会默认允许。移除该专用策略后，本插件按上项直接启用适用的 ASK 基线。这是附件明确选定的策略承接方式，必须在差异表和测试中写明“原版未配置策略时 ALLOW，插件 ASK 模式命中时 ASK”，不能声称该情形与原版完全一致。其余保留的硬拒绝、固定放行、可信来源、用户/会话规则及 AUTO 的先后关系不因本次迁移被意外改变。产品档位不是 Hermes profile；规则组显式配置，不默认赋予 PRO 或可信来源。
- 规则分别使用**命令实际工作目录**解析相对路径，用**用户工作区根目录**判断是否越界。原代码多处用同一个 `action.cwd` 表示这两个值，迁移时把它们分开传入。这样，用户在工作区外指定 `workdir` 时，规则仍能识别越界。 [工作区外修改规则](D:/liantong/projects/python/UniClaw/UniClaw/libs/hexagent/hexagent/harness/guardrail/detectors/shell/workspace.py:126) · [相对路径解析](D:/liantong/projects/python/UniClaw/UniClaw/libs/hexagent/hexagent/harness/guardrail/detectors/shell/workspace.py:249)

## 4. 按 138 条规则决定工具接入范围

按 UniClaw `c6a66bbf` 的 `ALL_RULES` 实际统计，138 条规则包括 **112 条 Shell、11 条文件、7 条工具参数、2 条网络、6 条数据**。其中 108 条硬拒绝、30 条需要询问。分组按规则定义文件统计。部分文件和数据规则也由 Shell 调用触发。规则按原操作系统和产品档位选择。以下是第二阶段要实现并验证的本机工具入口。 [源规则注册表](D:/liantong/projects/python/UniClaw/UniClaw/libs/hexagent/hexagent/harness/guardrail/baseline_rules/registry.py:17)

| Hermes 入口 | 接入方式和理由 |
|---|---|
| `write_file`、`patch(mode="replace")` | 用 Hermes 已有的单文件路径解析，把写入或替换的实际目标交给引擎。已存在 `ctx.resolve_file_path()`，无需另加单文件路径接口。 |
| `patch(mode="patch")`（V4A） | **需要补宿主接口。** 安装目录保护检查每个目标，删除规则还要求知道操作是删除。Hermes 要交出整次补丁的实际操作和路径。Add、Update 按写入判断，Delete 按删除判断，Move 分别检查来源的移除和去向的写入。复用宿主解析和路径处理，保留 Delete、Move 对目录项本身操作的语义。一次调用聚合 `DENY > ASK > ALLOW`，在修改第一个文件前完成判断。 |
| `terminal` | **需要补宿主接口。** 终端规则覆盖系统修改、凭据外发、工作区外写入等操作。仅凭原始 `command` 和 `workdir` 并不总能确定相对路径或脚本最终指向哪里。由 Hermes 提供实际命令、执行端 OS、Shell、最终工作目录和工作区根目录。遇到需要检查的本地脚本时，在同一个执行环境中按原有大小上限读取。 |
| `read_file`、`search_files`、`web_search`、`web_extract`、`browser_navigate` | 按原工具名和参数格式接入。文件读取和搜索复用任务路径解析，网页工具检查查询或 URL，`web_extract` 的 URL 列表逐项判断。可以复用已有 `pre_tool_call` 做输入准备；凡参数仍可被后续 Hook/中间件修改，最终授权必须通过新 Hook 检查实际使用的输入。不能仅以“未改写时有效”标记全面适配通过。 |

这张表是首批必做入口，不能替代全量能力清单。任务 1 必须逐项核对全部源规则和辅助 API：若其他规则还依赖任务管理、委派、记忆或其它操作，Hermes 有等价入口时补对应适配器和基础测试；没有等价入口时列出依据、影响和原因，不编造工具同义关系。敏感文本原本只提供检测 API，阶段二验收安装后可调用且结果正确，不增加输出过滤、附件扫描或自动外发阻断。

`execute_code` 在 Hermes 中执行 Python，不能套用 UniClaw 中的 Bash 别名。其直接 Python 副作用及内部工具调用需分别标注：不能通过外层工具映射就声称已保护 Python 任意写文件。若范围内源规则需要此入口而尚无等价解析/控制，记录为阻塞或明确无等价映射，不能算入已接入工具数。保持本轮日常聊天范围，不恢复 Codex runtime 适配工作。

两项对照已用 UniClaw 原函数验证。相同的 `touch report.txt` 在不同工作目录解析成不同目标。同一路径的普通编辑不命中 `common.filesystem.delete_mutation`，按删除处理时会命中。由此可见，V4A 必须传实际操作类型，终端必须传实际工作目录。 [安装目录规则](D:/liantong/projects/python/UniClaw/UniClaw/libs/hexagent/hexagent/harness/guardrail/detectors/filesystem.py:63) · [删除规则](D:/liantong/projects/python/UniClaw/UniClaw/libs/hexagent/hexagent/harness/guardrail/detectors/filesystem.py:116) · [V4A 执行实现](D:/liantong/projects/python/hermes-agent/tools/file_tools.py:957) · [终端工作目录](D:/liantong/projects/python/hermes-agent/tools/terminal_tool.py:896)

## 5. 补一个通用 Hook，并接入插件回调

**结论是补一个通用的“工具准备完成后、实际执行前”Hook，拟名 `pre_tool_execute`。** 现有 `pre_tool_call` 会先调用各回调，再合并 `modify`，且 V4A 目标和终端工作目录在工具内部才准备好。单纯给原 Hook 增加字段，仍无法保证规则检查的就是随后实际执行的操作。 [现有 Hook 合并顺序](D:/liantong/projects/python/hermes-agent/hermes_cli/plugins.py:1962) · [终端前台执行](D:/liantong/projects/python/hermes-agent/tools/terminal_tool.py:1218)

1. 在 Hermes 的文件写入、补丁和终端执行路径里，在实际参数及目标准备完成后调用同一个新 Hook。文件传操作和解析后的目标列表，终端传实际执行信息。回调只读，执行端使用同一份经过检查的信息。等待审批或重试期间如果目标、命令或工作目录变化，重新检查。前台和后台终端从同一授权入口进入。读取、搜索、网页等已纳入范围的入口也必须保证其最后一次参数改写之后的授权，必要时接入相同 Hook。
2. 在 `security-guardrail` 中用新 Hook 接管实际执行的最终规则判断。现有 `pre_tool_call` 可以承担尚未执行操作的输入准备，但同一份实际执行输入只作一次最终授权，避免重复判断和审批。直接分发、Agent 串行/并行执行和 Tool Search 解包后的已接入工具都遵循同一约定；不能通过 `skip_pre_tool_call_hook` 一类上层标志跳过工具真实执行边界的检查。
3. 两个回调都沿用 Hermes 现有返回约定。`ALLOW` 返回 `None`，`DENY` 返回 `block`，`ASK` 返回 `approve` 并提供根据规则 ID、实际参数、目标和策略版本生成的 `rule_key` 摘要。参数解析失败或规则引擎出错时，在已接入的路径返回 `block`。提示和诊断只提供必要的原因和规则 ID，敏感原值留在内存中。

通用 Hook 只传 Hermes 已解析的执行信息和接收允许、阻断或审批指令。UniClaw 规则、ASK 选择和工具转换都在插件实现。

**拟定公共契约（实施时在同名专题模块落地并补文档）：**

```python
# hermes_cli/plugins_execution.py（新增；不承载 Guardrail 规则）
# PreparedToolExecution 为不可变、宿主构造的执行描述。
def enforce_tool_execution(execution: PreparedToolExecution) -> str | None:
    ...  # None：继续宿主流程；str：本次执行的阻断原因，审批由宿主完成。

# 插件回调：由 register(ctx) 注册到 pre_tool_execute。
def before_execute(*, execution: PreparedToolExecution) -> dict[str, str] | None:
    ...  # None / block / approve；不接受 modify。
```

执行描述至少包含工具名、最终参数、任务/会话/调用标识、后端、执行端 OS、Shell、最终 cwd、工作区根、文件操作与目标列表。每个目标区分原始值、解析值、操作类型、内容目标/目录项目标和 Move 两端；无该字段的操作明确为空或 unknown。快照必须深层只读或等价隔离，不能只冻结外层字典。宿主与插件的内部 GuardrailRequest 分离，插件负责映射。

宿主收齐所有策略结果后按拒绝优先再发起审批；ALLOW 只表示继续原有宿主检查，不跳过 Hermes 自带防护。已注册的授权回调异常、超时、无效指令或试图改写快照时阻断对应调用，必须同时覆盖通用 dispatcher 与外层异常处理。没有启用该策略插件时保留 Hermes 原行为；插件未加载时强制停用所有工具的部署机制不自动纳入本次。

授权键采用含策略版本、profile/会话作用域、规则、后端和实际执行输入的摘要，不仅使用工具名；键与普通日志不包含命令、正文及敏感原值。测试 Hermes 的 yolo、审批关闭和无人值守行为并如实说明，不借此重新定义整个 Hermes 审批系统。变更执行输入后授权不能复用。此 Hook 缩小检查与执行的不一致，不承诺文件系统对象在检查后不会被外部进程替换；阶段三继续验证该类竞态。

## 6. 安装并验收插件

1. 从待交付目录安装到临时 `<HERMES_HOME>/plugins/security-guardrail/`。用 `hermes plugins doctor <插件目录> --ci` 检查导入和注册，再用 `hermes plugins enable security-guardrail` 启用。检查加载来源，并验证禁用、重新启用后的行为。
2. 真实调用 `write_file` 和两种 `patch`。覆盖保护目录、普通目录、V4A 混合目标、Move 两端和 Delete 操作。只要一个目标硬拒绝，断言整个补丁没有写入。加入另一个 Hook 将安全路径改到保护目录的回归用例，断言新 Hook 检查改写后的目标并阻断写入。
3. 用无害命令验证终端的显式 `workdir`、会话当前目录、相对路径和本地脚本。分别检查前台和后台路径。用固定的测试用例验证工作区外修改触发 `ASK`，批准后只执行一次，拒绝或超时时文件保持原状。破坏性命令仅用原规则的离线测试判断。
4. 对读取、搜索和网页工具验证第 4 节的映射。在同一进程做 profile A→B→A，验证各自的策略和审批记录。用 `scripts/run_tests.sh` 运行迁入的规则测试和真实工具调用回归。 [测试入口](D:/liantong/projects/python/hermes-agent/scripts/run_tests.sh) · [现有回归测试](D:/liantong/projects/python/hermes-agent/tests/plugins/test_security_guardrail.py:64)

验收时分别记录每条规则的迁移状态、规则测试结果，以及哪些工具和环境已通过真实调用。138 是源规则数，运行时覆盖以实际验证过的工具、操作系统和后端为准。

## 7. 文件分工与能力覆盖表

本阶段沿用当前 `plugins/security-guardrail/` 作为工作目录，安装临时 profile 中的候选插件验证。独立插件仓库交付沿用总计划安排；本轮不创建仓库、不发布、不切换实际账号配置，不把阶段一已有的源码位置当作发布方式已确定。

| 文件或目录（拟定） | 职责 |
|---|---|
| `plugins/security-guardrail/plugin.yaml`、`__init__.py` | 依赖、配置、Hook 声明与轻量注册；不在注册阶段建立产品环境。 |
| `plugins/security-guardrail/contracts.py` | 内部 GuardrailRequest 与上下文/决策边界，保持引擎与宿主隔离。 |
| `plugins/security-guardrail/adapters/hermes.py` | 工具和执行描述转换、配置读取、决策聚合、宿主结果映射。 |
| `plugins/security-guardrail/guardrail/**` | 范围内原引擎、规则、解析器、检测器及资源；安全中心专用内容排除。 |
| `plugins/security-guardrail/docs/migration-inventory.md` | 逐文件/函数/规则/API/资源/原测试的来源、去向、理由及状态。 |
| `plugins/security-guardrail/docs/capability-matrix.md` | 每类能力与 Hermes 入口、执行环境和证据；阶段二的主要验收依据。 |
| `hermes_cli/plugins_execution.py`（新增） | 通用执行描述、最终授权分发和原生审批衔接。 |
| `hermes_cli/plugins.py`、`plugins_dispatch.py` 及实际所属的插件模块 | 注册新 Hook、超时和错误阻断契约，复用已有基础设施，不把大段实现追加到 facade。 |
| `tools/file_tools.py`、`tools/terminal_tool.py` 及相关专题 sibling | 在本机真实文件操作和前后台命令执行前构造快照并调用通用授权。优先复用已有解析器。 |
| `tools/web_tools.py`、`tools/browser_tool.py` 及实际拥有搜索/网页执行入口的 sibling | 在确有参数改写可能的已接入入口接上最终授权；落点以当前真实调用链为准，不对整个浏览器模块无关重构。 |
| `model_tools.py`、`agent/tool_executor.py`（必要时） | 对齐入口和调用标识传递，防止重复审批或绕过；规则不进入这些 core 文件。 |
| `tests/plugins/test_security_guardrail.py` 与 `tests/plugins/security_guardrail/` | 保留真实文件回归；迁入规则测试，新增映射、资源与隔离测试。 |
| `tests/hermes_cli/test_plugins_execution.py`、`tests/tools/`、`tests/agent/` | 通用 Hook 契约、实际执行点、直接/Agent 路径与故障回归。 |
| `website/docs/developer-guide/plugins/index.md`、插件 `README.md` | Hook 契约、迁移差异、运行模式、安装与覆盖范围。 |

覆盖表每行至少记录：源能力/规则 ID/API、是否属于排除项、原调用方式、Hermes 入口与操作类型、所需可信信息及提供接口、OS/后端、策略模式、迁移状态、规则测试、真实接入测试、结果与副作用、差异/阻塞原因、负责的实施任务。

| 状态 | 可据此宣称什么 | 阶段二是否闭合 |
|---|---|---|
| 适配通过 | 等价入口输入正确，原判断及宿主决策执行通过基础验证 | 是，仅限记录的工具/环境。 |
| API 迁移通过 | 原功能仅提供独立 API，插件安装后可调用且结果测试通过 | 是；不计为自动运行的防护入口。 |
| 明确排除 | 安全中心专用功能/审计链路，附源位置和排除依据 | 是；不计入迁入能力。 |
| 无等价入口 | Hermes 中确实没有对应操作，附核对依据和功能差异 | 清单可闭合；交付必须保留差异说明，不能称该功能已等价适配。 |
| 待接入/缺接口/已知绕过/待验证 | 仅有代码，或对应 Hermes 操作尚缺映射、可信信息、控制或证据 | 否；第二阶段不能整体标为通过。 |
| 待其他环境验证 | 本机已通过，Unix、SSH、容器等环境尚未测试 | 当前环境可通过；不能扩张为跨环境已通过。 |

范围内有等价 Hermes 操作的能力必须逐类接通并验证；“无等价入口”不能替代尚未开发的适配器。某项实在无法等价实现时给出原因和影响，由用户审阅差异后决定如何交付，不自行缩小已确认范围。没有源规则的 Hermes 新工具不因此新增安全算法。

## 8. 第二阶段执行任务（确认后实施）

### 任务 1：固定来源与排除清单

输入：源目录、上述两个提交和本文件边界。输出：迁移清单及覆盖表初稿。

- [x] 记录源码提交和运行环境；复核文件、规则、资源、许可证、源测试及函数调用方。
- [x] 按源规则实际输入列出全部能力及 Hermes 候选等价入口；逐项标记安全中心、审计和逐条 ASK 设置的排除位置，混合文件按字段/函数拆分。候选映射仍需后续真实调用证明。
- [x] 运行并保存现有 Demo 基线；复现附件记录的参数改写绕过，保留失败证据与严格 xfail 回归。
- [x] 清单检查：每个源项有去向，每类规则有适配任务；独立敏感检测标为 API 迁移。形成可独立审阅的盘点成果。

完成记录（2026-11-10）：[迁移清单](../../plugins/security-guardrail/docs/migration-inventory.md)、[能力覆盖表](../../plugins/security-guardrail/docs/capability-matrix.md)、[基线与已知缺口证据](evidence/phase2-task1/verification.md)。实际盘点为 60 个 Python 文件、2 个资源、138 条规则、28 个原测试。最终 Demo 回归 3 passed / 1 skipped / 1 xfailed；参数改写缺口用 `--runxfail` 已证明失败，尚未修复，继续阻塞第二阶段总验收。任务 2 至 6 尚未实施。

### 任务 2：迁入引擎、资源和内部契约

输入：任务 1 的范围清单。输出：无 UniClaw 安装依赖的可导入引擎及 `evaluate_tool_call(request: GuardrailRequest) -> PermissionDecision` 内部入口。

- [x] 先添加迁移对照用例：已观察未迁入 contracts 时明确失败；随后验证完整规则元数据、资源缺损与禁止产品导入的隔离子进程。
- [x] 迁入范围内 57 个源码模块、2 个资源和许可证；调整相对导入和动态包资源读取，用 manifest 声明 Pydantic 依赖。复用已有符合范围的 PM 测试环境，无需安装或重建。
- [x] 移除被排除的审计/安全中心依赖；保留通用匹配与决策优先级，按第 3 节承接 ASK。拆分执行 cwd 与 workspace_root，环境/探测/脚本读取由显式输入提供。
- [x] 对照原规则元数据，176 组源引擎实际决策一致；验证硬拒绝优先级、AUTO、全部适用 ASK 代表输入、产品规则组及敏感 API。差异单列，未称全部原测试矩阵已运行。
- [x] 安装副本可独立导入，资源与许可哈希一致，敏感 API 可调用，Doctor 通过；修复审查发现的保护根输入校验缺口后，完整相关回归通过。

完成记录（2026-11-10）：[任务 2 迁入记录](../../plugins/security-guardrail/docs/task2-migration.md)、[逐文件实际结果](evidence/phase2-task2/migration-result.json)、[最终测试日志](evidence/phase2-task2/final-tests.log)。16 个文件，1208 passed / 1 skipped / 1 xfailed；已知参数改写缺口仍属于任务 3。当前 register(ctx) 保留 Demo，尚未把新引擎接入实际 Hermes 工具，不据此宣称第二阶段整体通过。下一任务为通用执行前 Hook。

### 任务 3：实现通用执行前 Hook

输入：第 5 节公共契约及任务 1 的真实失败用例。输出：`pre_tool_execute`、执行快照、统一决策与审批分发；此任务不能只产出 Hook 名称而没有真实执行接入点。

- [ ] 先写通用行为用例：先传普通目标再由 Hook/中间件改到保护目标时应阻断；回调超时、异常、无效返回或篡改快照应阻断。
- [ ] 在专题模块实现执行描述和 `enforce_tool_execution`，注册并文档化 Hook，复用 profile 作用域及原生审批。无策略注册时保留原有工具行为。
- [ ] 在文件、补丁和终端准备结束处接入同一通用授权；为其他已接入操作确认最终检查位置，不能留下已知后续改写绕过。
- [ ] 验证所有参数改写已发生在检查之前，拒绝优先于审批；批准后执行检查过的输入，输入改变重新授权；直接调用、Agent 串行/并行及解包路径不重复、不跳过。
- [ ] 验证不含 Guardrail 规则、产品目录或插件名分支；通过第 9 节对应测试后形成通用宿主扩展的独立差异。

### 任务 4：连接插件与文件类适配器

输入：任务 2 引擎、任务 3 Hook。输出：`register(ctx)` 注册真实策略回调，文件类覆盖表标记及磁盘证据。

- [ ] 先添加真实适配用例，确保复制代码但没有注册新 Hook 时无法得到所需决策。
- [ ] 实现 Hermes 回调到 GuardrailRequest 的转换和 `DENY > ASK > ALLOW` 聚合；替换 Demo 判定，保留其保护目录场景。
- [ ] 接通 write_file、replace、V4A Add/Update/Delete/Move；复用宿主解析，Move 两端及目录项语义完整，多目标在首个修改前统一判断。
- [ ] 验证拒绝不创建/不改写文件，允许真正写入，删除/移动类型正确；混合目标拒绝时所有文件保持原状，覆盖 CRLF、错误补丁、相对路径、大小写及本机链接。
- [ ] 安装到临时 profile 验证真实回调加载来源和决策；完成该能力族后更新覆盖表，不能据此将其他族标为完成。

### 任务 5：终端及其余范围内能力逐类接入

输入：任务 1 的完整映射清单、任务 3 的宿主执行信息。输出：终端和其他适配器的逐类证据。

- [ ] 先验证不能混用最终 cwd 和工作区根：相同相对命令在不同 cwd 生成不同操作目标，在工作区外指定 workdir 仍识别越界。
- [ ] 接通终端前后台授权、实际 OS/Shell、最终 cwd 和同环境受限脚本读取；未知关键输入不能猜成可信本机数据。
- [ ] 以无害命令验证 ASK 批准一次、拒绝、超时、参数变更后重新审批和无人值守行为；破坏性命令仅离线判断。
- [ ] 接通读取、搜索、网页工具与任务 1 确认的其他等价入口；URL 列表逐项聚合；Tool Search 检查实际工具而非外层名称。
- [ ] 每类至少完成输入映射、适用规则/固定放行语义、真实调用及决策执行验证；适用的 ALLOW/DENY/ASK 分支分别验证，不为本来固定放行的工具制造不存在的 ASK 行为。
- [ ] 对无等价入口、Python 直接副作用和其他执行环境逐项写明差异；不能以错误别名补齐数量。

### 任务 6：完整安装、隔离与阶段二验收

输入：候选插件目录、通用宿主扩展和全部覆盖表。输出：阶段二验收报告与阶段三输入清单。

- [ ] 从候选目录安装到全新临时 profile，运行 Doctor，验证依赖、资源、启用/禁用/重新启用以及实际加载来源；不修改正在使用的 C 盘账号配置。
- [ ] 同进程 profile A→B→A，用相同 session 标识但不同保护目录/模式验证配置、策略、缓存与审批记录不串用。
- [ ] 运行迁入规则、适配器、真实工具、通用 Hook 和实际受影响模块的测试；分类迁移回归、原有失败、环境问题和接口缺口。
- [ ] 审阅每个源项和各类适配覆盖状态；未接入、有已知绕过或缺少基础证据的适用能力不得标为通过。
- [ ] 报告原判断保留情况、ASK 明确差异、无等价项、环境限制及证据。第三阶段接手复杂输入、误报漏报、绕过和竞态的系统校验，第四阶段接手实际部署与业务验收。

## 9. 验证入口、完成判定与评审重点

Python 验证统一用 `scripts/run_tests.sh`。以下为任务实施后的计划命令，本轮文档更新未执行这些测试；新增测试路径在所属任务创建。

```bash
hermes plugins doctor <候选插件目录> --ci
scripts/run_tests.sh tests/plugins/test_security_guardrail.py tests/plugins/security_guardrail/
scripts/run_tests.sh tests/hermes_cli/test_plugins_execution.py
# 各执行落点的 tests/tools/、tests/agent/ 回归按实际修改文件选择后记录命令和结果。
```

Doctor 成功表示声明、导入和注册检查通过，不能替代实际调用。拒绝用例必须有文件内容/时间或无害进程标记等副作用证据；允许用例必须真实成功。平台测试在对应 OS 执行，不伪造 sys.platform。测试使用隔离的 HERMES_HOME 与现有独立测试解释器，不改启动源码、不重装现用环境、不改业务账号配置。

**第二阶段通过条件同时满足：**

1. 源清单闭合，迁移范围内规则、解析、决策、独立 API、资源与必要依赖齐全；安全中心排除项有精确来源。
2. 全新 profile 可安装启用，所有具有等价 Hermes 入口的范围内能力逐类完成基础验证；无等价项有依据和明确差异。
3. 通用 `pre_tool_execute` 已落地并由插件真实注册调用，文件/终端关键执行信息来自宿主；已知参数改写缺口已修复且回归通过。
4. ALLOW/DENY/ASK 与多目标聚合在适用入口实际生效，授权范围正确；审批配置的实际语义及例外如实记录。
5. 原判断语义未被意外改变；已明确的 ASK 替换差异可追溯，profile 隔离、资源与故障基础测试通过。
6. 能力覆盖表作为总验收依据，不存在冒充已适配的待接入/缺接口/已知绕过项；阶段三、四工作及本阶段环境范围写明。

评审重点与对应任务：① 最终参数在检查后变化（任务 3、4、5）；② V4A 删除/移动目标或部分执行错误（任务 4）；③ cwd 与工作区混淆、Shell/执行端未知（任务 5）；④ 移除安全中心后 ASK 意外默认放行、原值进入授权键/日志（任务 2、3、5）；⑤ profile 串用或装入旧 Demo/缺资源版本（任务 2、6）。

本文件更新只涉及计划。文中候选模块与公共契约是后续开发的约定，尚未实现；用户确认后按任务顺序迁移，若实际源码要求改变已确认的功能语义或缩小范围，先报告差异。
