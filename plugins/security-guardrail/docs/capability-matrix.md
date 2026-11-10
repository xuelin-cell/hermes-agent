# Hermes Guardrail 能力覆盖表（任务 1 初稿）

日期：2026-11-10。源版本 `c6a66bbf`，Hermes `05b4b81558`。当前完成的是源能力盘点与阶段一基线，原引擎尚未迁入；下面的工具对应是待实施/核对的适配关系。不能把原 Demo 的阻断证据算作 138 条规则已经接入。

## 1. 规则与能力族闭合

逐条规则 ID、原顺序、OS、规则组、源定义、原测试直接引用、文件 SHA-256 见 [迁移清单](migration-inventory.md) 和 [机器快照](../../../docs/guardrail/evidence/phase2-task1/source-manifest.json)。实际读取 ALL_RULES：138 条，108 硬拒绝、30 ASK；common=120、lite=7、pro=11。所有规则定义保留，未将产品专用的路径例外与整条安全规则一同删除。

| 能力族 | 原规则数 | Hermes 入口/输入 | 可信信息与缺口 | 实施任务 | 当前状态 |
|---|---:|---|---|---|---|
| Shell 操作识别与决策 | 112 | terminal.command；前台/后台及本地脚本 | 实际 OS/Shell、最终 cwd、workspace_root、受限脚本读取；需要准备后的通用 Hook | 2、3、5 | 未迁入/缺接口 |
| 文件操作与保护 | 11 | write_file、patch、read_file、search_files；部分规则也由 Shell 触发 | 文件实际目标、操作类型、Delete/Move 目录项、Move 两端、保护根；已有单路径 ctx，缺完整执行描述 | 2、3、4、5 | Demo 目录规则已通；原规则未适配 |
| 工具契约 | 7 | 命令/文件/URL/查询必填校验、未知执行字段、搜索域过滤、公开发布 | 不能把宿主默认路径误判为空目标；公开发布需核对交付工具实际语义 | 2、3、4、5 | 未适配；发布入口待核对 |
| 网络目标 | 2 | web_extract.urls、browser_navigate.url；其他 URL 参数 | URL 批量拆分、原参数与最终使用值一致；实际 URL 重定向防护不由初始参数检查自动获得 | 2、3、5 | 未适配 |
| 数据暴露 | 6 | Shell 外发、URL/载荷及源检测器实际支持的工具类型 | 保留源检测条件，不把任意工具载荷强行当 Shell；日志/审批摘要不含原值 | 2、3、5 | 未适配 |
| 规范化、匹配、决策优先级 | 辅助能力 | 全部适配请求经 RuntimeAction/evaluate_tool_call | 操作类型、全部目标、调用来源由宿主构造，产品组与 Hermes profile 分离 | 2、4、5 | 未迁入 |
| 独立敏感文本检测 API | 独立 API，不计为新增基线规则 | inspect_sensitive_text(text, policy=...) | 插件包资源、Pydantic 声明、合成测试；不新增自动外发拦截 | 2、6 | 待 API 迁移验证 |

保留 Linux/macOS/VM 规则不代表本机 Windows 可以验证它们。规则选取沿用原 OS/产品组条件；远端和其他平台保留待验证状态，不把未知 OS 自动设为本机。产品安装目录、关键配置路径、便携 sessions、可信安装器、VM 挂载与 MCP 缓存必须由 Hermes 适配或显式登记限制，不能默认继承 UniClaw 的例外。

## 2. 全部 35 个源标准工具的去向

此表从源 CANONICAL_TOOL_CLASSIFICATION 逐项登记。多数源标准工具本来没有专属基线规则，保留分类/固定放行语义即可，不因此新增安全算法。列为候选的对应关系尚未证明参数等价；任务 5 必须核对实际 schema 和执行路径。只有“源码名称相近”不构成已适配证据。

| 源标准工具 | Hermes 对应或候选 | 关键输入/边界 | 任务 | 状态 |
|---|---|---|---|---|
| Bash | terminal | command、实际 Shell、最终 cwd、工作区、脚本 | 3、5 | 待接入 |
| PowerShell | terminal | 以真实执行 Shell 判定，不能根据命令文本猜类型 | 3、5 | 待接入 |
| Read | read_file | path 及宿主解析目标；原固定放行前仍检查硬拒绝 | 3、5 | 待接入 |
| Glob | search_files(target=files) | 实际默认路径、pattern、解析目标 | 3、5 | 待 schema 核对/接入 |
| Grep | search_files(target=content) | 实际默认路径、pattern、解析目标 | 3、5 | 待 schema 核对/接入 |
| Write | write_file | path、content、实际内容目标 | 3、4 | 原引擎待接入 |
| Edit | patch replace/V4A | 替换内容、多目标、操作语义 | 3、4 | 待接入 |
| NotebookEdit | 无已确认的结构化单元格等价入口 | 不能把通用 JSON patch 当成同义；保留源分类/规则 | 5 | 无直接对应候选，待最终核对 |
| FileWrite | write_file | 与 Write 同一适配器，保留别名 | 3、4 | 待接入 |
| FileEdit | patch | 与 Edit 同一适配器，保留别名 | 3、4 | 待接入 |
| WebFetch | web_extract / browser_navigate | url、urls 批量、最终参数；浏览器交互另列 | 3、5 | 待接入 |
| WebBatchFetch | web_extract | URL 列表逐项决策并聚合 | 3、5 | 待接入 |
| WebCrawl | 未确认递归抓取等价入口 | 普通 extract 不自动具有 crawl 的深度语义 | 5 | 无直接对应候选，待最终核对 |
| WebSearch | web_search | query 和实际域过滤参数；保留源固定放行顺序 | 3、5 | 待接入 |
| Agent | delegate_task 候选 | 子任务提示、执行类型；发起请求与子任务内部调用分开 | 5 | 待语义核对 |
| CronJob | cronjob_manage | create/update/remove/trigger 等动作映射；调度实际触发另验 | 5 | 待语义核对 |
| TaskOutput | process_manage 候选 | poll/log/wait 与任务输出身份的区别 | 5 | 待语义核对 |
| TaskStop | process_manage 候选 | kill 与原任务停止范围的区别 | 5 | 待语义核对 |
| Skill | skill_view 候选 | skill 名不构成可信来源；skill_manage 写动作另分 | 5 | 待语义核对 |
| ToolSearch | tool_search/tool_describe/tool_call | 搜索可保留固定放行；解包后检查实际执行工具 | 3、5 | 待接入 |
| TodoWrite | todo_list | todo 数据；保留原固定放行语义 | 5 | 待语义核对 |
| Memory | memory | action/content/new/old 等操作字段 | 5 | 待语义核对 |
| AskUserQuestion | clarify | 提问内容、宿主交互，与权限审批分开 | 5 | 待语义核对 |
| ReadMe | 未确认模块说明等价入口 | read_file 可读文件，不代表其模块说明参数等价 | 5 | 无直接对应候选，待最终核对 |
| ShowWidget | 未确认同义展示工具 | Desktop 能力和实际工具 schema 需核对 | 5 | 待宿主入口核对 |
| PresentToUser | Desktop 交付插件候选 | 文件列表、附件、真实交付点；不等于公网发布 | 5 | 待宿主入口核对 |
| PptxProgress | 未确认专用进度工具 | 原文件目标、展示语义；不新增 PPT 进度系统 | 5 | 无直接对应候选，待最终核对 |
| PublishArtifact | 交付/分享插件候选 | action=publish 才触发源公开发布 ASK；本地展示不等价 | 5 | 待真实发送/发布入口核对 |
| Conversation | session_search 候选 | 会话列表/读取与语义搜索的动作差异 | 5 | 待语义核对 |
| SessionSearch | session_search | query、session_id 与来源范围 | 5 | 待语义核对 |
| Digest | memory 候选 | 保存/读取摘要与一般记忆不同，不硬映射 | 5 | 待语义核对 |
| DelegateTask | delegate_task | 子任务描述、身份、调用范围 | 5 | 待语义核对 |
| QueryAgentStatus | 未确认同义入口 | 后台进程状态不自动等于 Agent 状态 | 5 | 无直接对应候选，待最终核对 |
| ReportStatus | 未确认同义入口 | 状态上报内容、收件范围和发送点 | 5 | 待宿主入口核对 |
| AskColleague | 未确认同义入口 | 同事身份与权限不能从模型参数认定 | 5 | 无直接对应候选，待最终核对 |

额外边界：源 execute_code 别名指向 Bash，而 Hermes execute_code 运行 Python。明确不套用该错误别名。其内部工具调用需要沿实际分发路径检查；直接 Python 文件/网络副作用不因此得到拦截。当前任务只登记此差异，不声称覆盖，也不重新开启 Codex runtime 适配。MCP、Connector、自定义工具仍需未知执行字段等通用契约判断，不能因名称或模型声明成为可信来源。

## 3. 执行信息、调用路径和基础验收

| 项目 | 所需宿主信息/行为 | 当前情况 | 后续任务 |
|---|---|---|---|
| 本地单路径 | 任务 cwd、profile、实际文件后端 | 已有 ctx.resolve_file_path；本机 Path 可解析，远端 PurePosixPath 不在宿主解引用 | 4、5 |
| V4A | 全部操作、全部目标、Move 两端、内容/目录项目标 | 原 Demo 无；必须复用宿主解析结果 | 3、4 |
| 终端执行 | 后端、OS、Shell、最终 cwd、workspace_root、本地脚本受限读取 | 原始 command/workdir 不足，需要准备后快照 | 3、5 |
| 最终参数一致性 | 所有改写之后检查，执行使用同份只读快照 | 已知缺口已真实复现；阻塞阶段二最终通过 | 3 |
| 直接分发 | model_tools.handle_function_call 到真实工具 | Demo 已测；新引擎/新 Hook 未接入 | 3、4、5 |
| Agent 串行/并行、Tool Search 解包 | 实际调用标识与最终工具；单次最终授权 | 代码路径待运行时验证，不以直接分发测试替代 | 3、5 |
| ALLOW / DENY / ASK | 返回宿主决策；拒绝无副作用，审批绑定实际输入 | Demo 仅 DENY/继续；ASK 未接入 | 3、4、5 |
| profile A→B→A | 策略、模式、保护根、授权缓存隔离 | Demo 目录配置已测；正式策略/审批状态待验 | 6 |
| 独立敏感 API | 可调用、有合成正反例、资源缺损错误、原值不出日志 | 未迁入；不要求自动挂发送 Hook | 2、6 |

本阶段 Windows 本地工具后端为已确定的实施环境；Unix/macOS、SSH、容器等为待验证，不伪造平台。Desktop 已有第一阶段用户手测记录，第二阶段仍需验证新引擎；Gateway、cron、子 Agent 内部调用分别登记真实执行路径，不能由“共享 Python 模块”推断已通过。

## 4. 状态与通过条件

- 当前任务 1 完成的是清单和证据；除 Demo 基线外，没有任何原引擎适配项标为完成。
- 下一任务 2 负责代码/资源/API 迁入；任务 3 负责已知执行链缺口；任务 4/5 负责所有范围内对应能力；任务 6 负责总验收。
- 后续为每个实际接入项补充测试名称、命令、OS/后端、模式、调用/规则标识、真实副作用结果及差异，不只写“可调用”。
- 无对应入口须附依据并经差异审阅；有等价工具但未接入、缺接口、存在已知绕过或缺基础验证的项目，不能计为适配通过。
- 独立 API 迁移通过、排除项闭合与运行时防护接入通过分别统计。第三阶段再系统检验防护效果、误报漏报和复杂绕过。
