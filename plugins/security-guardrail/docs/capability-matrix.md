# Hermes Guardrail 能力覆盖表（任务 3～5）

日期：2026-11-10；源 `c6a66bbf`；本轮开发基线 `9c2539b2ed`。引擎 138 条规则定义及优先级保留，真实插件已替换 Demo。详细实现见 [适配记录](task3-5-adaptation.md)。**本表区分接线、基础测试和等价缺口，不宣称第二阶段整体完成。**

## 规则与能力族

| 能力族 | 原规则数 | 当前接入 | 基础证据/限制 |
|---|---:|---|---|
| Shell 规范化与决策 | 112 | 本地 Bash 前台/后台；字面路径脚本；本机路径、MSYS 盘符、稳定链接目标 | terminal 测试；不能确认执行端/脚本变量展开时拒绝；其他 OS 保留但本轮未实测 |
| 文件操作与保护 | 11 | write_file、replace/V4A Add/Update/Delete/Move、read/search | file/patch 测试，真实磁盘不变/实际修改；Move 两端和目录项；复杂移动链接依赖拒绝 |
| 工具契约 | 7 | 必填命令/路径/URL/查询、域过滤冲突、未知执行字段 | other_tools 测试；公开发布规则保留 API，当前无同义模型工具入口 |
| 网络目标 | 2 | 规范化后的 web_extract 每一实际 URL、browser_navigate；查询 | 拒绝发生在 Provider/浏览器路由前；搜索/提取 ALLOW 用本地测试 Provider 验证；未访问公网；重定向另列 |
| 数据暴露 | 6 | 源 Shell/URL/载荷检测经同一引擎执行 | 保留原检测条件，合成数据原回归；不将任意工具文本当成 Shell，不新增自动敏感过滤 |
| 决策与状态 | 辅助 | 硬拒绝/原固定放行/用户规则/会话允许/AUTO/ASK | policy 测试与原语义回归；ASK 复用宿主审批；跨账号保护根 A→B→A 已测，完整审批隔离仍属任务 6 |
| 独立敏感 API | 独立 API | 可调用、包内资源、Pydantic 依赖 | task2 独立安装及原合成样本测试；不代表自动外发拦截 |

规则计数：108 deny、30 ASK；common=120、lite=7、pro=11。选择沿用源 OS/规则组条件。`protected_roots` 复用原 product_install_dir_access：可拒绝读取、写入和 Shell 路径引用；配置时应选择真正需要隔离的目录。

## 全部 35 个源标准工具的去向

“API 保留”表示可通过插件内部 GuardrailRequest 显式调用原标准工具语义，没有冒充 Hermes 已具备相同模型工具。

| 源标准工具 | Hermes 入口/当前判定 | 证据与边界 |
|---|---|---|
| Bash | terminal → Bash | 前台/后台 ALLOW/DENY/ASK；真实脚本、cwd、MSYS/链接回归 |
| PowerShell | API 保留；无独立原生 Shell 入口 | 不从命令文字猜宿主 Shell；Bash 启动的 ps1 仍按原引用脚本检测器处理；独立 PS 待宿主实际信息 |
| Read | read_file → Read | 真实读取；实际路径；硬拒绝先于固定放行 |
| Glob | search_files(target=files) → Glob | 真实文件搜索；缺省路径采用宿主实际根 |
| Grep | search_files(target=content) → Grep | 真实内容搜索；路径和 pattern 传入 |
| Write | write_file → Write | 真实保护目录拒绝/普通目录允许/用户和会话规则 |
| Edit | patch → Edit + 实际操作 | replace、V4A 全操作与多目标验证 |
| NotebookEdit | API 保留；无结构化单元格工具 | execute_code Python 不能当单元格编辑同义入口 |
| FileWrite | write_file 使用 Write 标准入口 | 源 FileWrite 别名/API 保留；Hermes user_rules 使用 Write；不做两个入口的重复审批 |
| FileEdit | patch 使用 Edit 标准入口 | 源 FileEdit 别名/API 保留；Hermes user_rules 使用 Edit |
| WebFetch | browser_navigate / 单 URL 检查 → WebFetch | 规范化 URL，硬拒绝先于原固定放行；浏览器业务后端未在本轮启动 |
| WebBatchFetch | web_extract 保留批次契约，并逐 URL 硬拒绝 | 批次用户规则不被 WebFetch 固定放行替代；实际 Provider 输入一致 |
| WebCrawl | API 保留；无递归抓取同义入口 | 不将 extract 的 URL 列表称为 crawl |
| WebSearch | web_search → WebSearch | 真实查询、本地测试 Provider、缺 query/域过滤冲突拒绝 |
| Agent | API 保留；delegate_task 选择 DelegateTask 语义 | 无 resume/subagent_type 等完整对等字段，不声称两类接口同时等价 |
| CronJob | cronjob_manage → CronJob | action/prompt/job_id 传入；真实 list 已验；调度触发/无人值守完整业务属任务 6 |
| TaskOutput | process_manage list/poll/log/wait → TaskOutput | 真实后台进程 list/poll/log/kill 已验；action/会话标识映射；更完整生命周期留验收 |
| TaskStop | process_manage kill → TaskStop | 发起口已接；不将 write/submit/close/handoff 误作只读 TaskOutput |
| Skill | skill_view → Skill | name 转 skill；真实临时技能读取；来源保持普通 Agent，模型名称不授予可信特权 |
| ToolSearch | tool_search/tool_describe → ToolSearch | 目录读取有最终 gate；tool_call 解包后只授权实际工具；真实 todo 解包验证 |
| TodoWrite | todo_list → TodoWrite | 真实内联 TodoStore，保留固定放行语义 |
| Memory | memory → Memory | 真实内联保存、串行/线程拒绝无写入 |
| AskUserQuestion | clarify → AskUserQuestion | 单/批问题转 questions；真实 clarify handler 和本地回答回调已验，桌面 UI 待任务 6 |
| ReadMe | API 保留；无模块说明同义入口 | read_file 不作为该 API 的等价证明 |
| ShowWidget | API 保留；无同义结构化模型工具 | 现有 desktop_preview/预览回调不是 widget_code 接口 |
| PresentToUser | API 保留；无同义模型工具 | desktop-deliverables 是自动结果观察/交付，不是显式文件列表工具；不改其业务 |
| PptxProgress | API 保留；无专用进度入口 | 不新增 PPT 进度系统 |
| PublishArtifact | API 保留；无同义模型公开发布工具 | conversation_share 是 Dashboard API；现有本地交付不能冒称 publish；不对 UI 路由宣称已防护 |
| Conversation | API 保留；session_search 使用 SessionSearch 语义 | 浏览最近会话/定位消息存在宿主差异，不追加另一个原标准分类改变用户规则含义 |
| SessionSearch | session_search → SessionSearch | query/session_id 传入，Agent 内联同一最终入口；真实临时 SessionDB 读取已验 |
| Digest | API 保留；无同义摘要存取入口 | memory 的一般内容写入不冒称 save/latest 接口 |
| DelegateTask | delegate_task → DelegateTask | goal/tasks 转 task_description；Agent 回调允许/用户拒绝已验；真实模型子任务启动留任务 6 |
| QueryAgentStatus | API 保留；无同义入口 | 后台进程状态不能当作 Agent 状态 |
| ReportStatus | API 保留；无同义入口 | 不把 send_message 任意消息认作原任务状态协议 |
| AskColleague | API 保留；无同义入口 | 不从模型提供的同事名推导权限 |

## 执行链覆盖与缺口

| 项目 | 当前状态 |
|---|---|
| 原 pre_tool_call 后改参数 | 已修复；回归由 XFAIL 转 PASS，执行使用最后检查的目标 |
| 请求/执行中间件后最终检查 | 已接；注册表、连接器和非注册表 Agent 入口共用 generic gate |
| 文件准备 | 已接；Windows 链接/大小写/相似前缀、目录项及 Move 两端；复杂移动链接依赖整批拒绝 |
| 终端准备 | 本地 Bash 支持；最终 cwd 和固定工作区分离；前台/后台固定实际 cwd；拒绝优先于审批 |
| 脚本读取 | 本地常规文件、1MiB+1 上限；缺信息/过大拒绝；持久环境变量脚本路径尚不能等价放行 |
| 远端/未知 Shell | 不套本机元数据；相关文件/命令拒绝。需执行端 OS、Shell 和同环境读取接口后再支持 |
| Python execute_code | 不映射 Bash，当前 unknown_exec_field 拒绝；Python 直接副作用分析未实现 |
| process stdin / 其他浏览器交互 / UI 分享 | 无对应源协议或未准备完整语义；仅通用未知工具规则，不能声称目录保护覆盖 |
| MCP/Connector/自定义工具 | 最终分发运行通用未知执行字段规则；不自动变可信、不自动过滤全部外发文本 |
| ASK | 原生 approve/deny/无人值守路径复用；键绑定输入/策略/作用域和脚本摘要；原宿主自动批准配置继续适用 |
| 多 profile | 原保护根 A→B→A 和禁用真实验证；完整同 session 审批缓存隔离尚由任务 6 验收 |
| 独立 API | task2 已迁入，当前继续回归；不要求自动挂发送 Hook |
| Desktop/Gateway/cron/真实子 Agent | 公共 Python 入口已接；本轮未重启用户桌面或实际调用模型，不写成客户端端到端已通过 |

## 验证入口

新增/更新：tests/plugins/test_security_guardrail*.py（含 data_tools 的真实存储/宿主回调/后台进程），tests/hermes_cli/test_plugins_execution.py，tests/agent/test_final_execution_policy.py。原 138 条定义及判断继续由 tests/plugins/security_guardrail/ 回归。

日志与确切通过数见 [verification.md](../../../docs/guardrail/evidence/phase2-task3-5/verification.md)。原始源清单、逐文件处理、规则对照保留在 migration-inventory.md 和 phase2-task1/task2 evidence，未用适配表替代来源审计。

完成口径：任务 3/4 支持链路和任务 5 已确认入口已实现；“发起口接线但业务待验”“API 保留/无等价”“拒绝未知信息”分别登记。任务 6 逐项审阅与总验收之前，不把这些状态合并为全量等价适配通过；第三阶段再评估真实安全效果、误报漏报、复杂绕过和竞态。
