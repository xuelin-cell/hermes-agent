# Hermes Guardrail 插件开发计划

**目标**：将 UniClaw 的工具操作规范化与权限决策能力接入 Hermes，先交付一个独立安装的 Hermes 专用 Python 插件。

**架构**：同一插件内分开规则判断与 Hermes 适配。规则模块根据操作、执行环境和策略计算决策。适配模块用 `register(ctx)` 注册 `pre_tool_call`，把决策映射到 Hermes 的工具阻断与审批。

**技术栈**：Hermes 管理的 Python 运行时、原生 `plugin.yaml`、pytest 和仓库测试入口。计划文件存于 Hermes 仓库，插件实现拟放独立仓库 `hermes-guardrail`，开发时从临时 profile 的插件目录加载。

**依据**：本会话已选定 Hermes 专用方案。开发人员要求优先使用 plugin 外挂，已有能力通过 hook 或 `ctx` 接入，缺口先扩展通用接口。Hermes 当前基线为 `release-anquan` / `ac5d0ef895`，UniClaw 为 `vm-uniwork-dev` / `c6a66bbf`。附件《Hermes 插件机制调研》以 `d8c79e4b6b` 为基线，部署能力以实际交付版本和验证结果为准。文末列出核对入口。

## 范围和约束

- 首期建议覆盖 `write_file`、`patch` 和一个明确的终端后端，迁移 3–5 条代表性规则。优先验证配置的受保护目录、适用于目标系统的危险修改规则，以及工作区外写入审批。目标客户端、Shell、规则清单及每条规则动作在任务 1 锁定。
- 首期以指定工具调用的执行前决策为验收边界。全量 UniClaw 规则、跨 Agent 发布、文本脱敏、安全中心 UI、远程执行隔离和审计平台另排。
- 用现有 `pre_tool_call` 和 Hermes 原生审批。插件不覆盖内置工具，不在 core 增加 Guardrail 专用分支，不导入 Hermes 私有函数作为运行依赖。确有接口缺口时，单列通用 hook 或 `ctx` 扩展。
- 规则配置走 `plugins.entries.<id>.settings`。依赖和状态跟随当前 profile，路径通过受支持的接口解析。行为配置不用 `.env`，运行期间不改写系统提示词和历史消息。阻断理由只显示必要信息，避免回显完整命令、原始秘密或文件正文。
- 附件所述 `pre_llm_call` 在当前基线只用于注入上下文。当前检出也未找到附件描述的 `plugins.isolation: host` 实现。首期的阻断和隔离均不依赖这两项。

## UniClaw 耦合项怎么处理

| 方式 | 适用场景 | 代价与风险 | 首期选择 |
|---|---|---|---|
| **去掉** | 只对 UniClaw 产品版本、目录或运维流程成立的规则和豁免 | 改动最小。若把同一文件里的通用保护一起删除，会丢失已有能力。 | 去掉专属路径识别和专属放行例外，逐条记录未迁移原因。 |
| **改为通用参数** | 保护应用目录、识别工作区边界、区分执行端系统等在 Hermes 中仍成立的安全意图 | 需要显式传递和校验上下文。若把规则匹配、配置 schema、发布接口全部通用化，会扩大首期范围。 | **作为保留安全规则的主方式。** 只抽取本次需要的参数，接口作为插件内部契约。 |
| **改为 Hermes 专用** | 工具参数、profile 数据路径、审批、插件安装兼容等宿主接线 | 交付直接。若把 Hermes 路径硬编码进规则引擎，规则难测，安装方式和后端变化也容易误判。 | 仅在 Hermes 适配层处理，由适配层把可信值传给规则模块。 |

逐项迁移决定如下。涉及保护范围变化的项目需要在规则清单中注明。

| 原耦合 | 首期处理 | 验收重点 |
|---|---|---|
| `contract.py` 的 `HEXAGENT_BUILD_VARIANT`，`BuildProfile.LITE/PRO/SERVER` 及规则分组 | 去掉运行时的 UniClaw 版本推断。按首期目标系统和后端列出规则 ID，选择确认适用的规则。不要默认赋值 `PRO`，也不要把 UniClaw build variant 当作 Hermes profile 或版本号。 | 未选规则不会因默认产品版本被意外启用。通用规则仍按其目标 OS 生效。 |
| `HEXAGENT_APP_DIR`、`HEXAGENT_DATA_DIR`、`HEXAGENT_PORTABLE`、`sys.frozen` | 去掉读取方式。保留 `PRODUCT_INSTALL_DIR_ACCESS` 的保护意图，改用适配层显式提供的 `protected_roots`。默认范围以部署确认的目录为准。若未来需要排除目录，单独规定并验证子目录边界。 | 受保护目录的子路径被拒绝，相似前缀的普通目录可写。不会因便携版原有例外自动放行。 |
| `path_policy.py` 的 `hexagent-lite`、`hexagent`、`uniwork` 数据目录与 `HEXAGENT_CONFIG_WRITE` | 去掉 UniClaw 专属名称和路径正则。若首期选入关键配置保护，由 Hermes 适配层提供经确认的具体配置路径。不要把整个 `HERMES_HOME` 默认列为阻断对象。 | 不串用不同 Hermes profile 的保护路径。不会误伤同名目录或目标范围外的会话文件。 |
| `delete_exempt.py` 的 Lite Windows `sessions` 清理例外，以及旧 MCP 缓存、安装脚本等例外 | 首期不迁移。只有 Hermes 存在对应操作、能辨认可信来源且具备测试时，再为该操作定义窄范围例外。 | 模型传来的工具名、参数或环境字段不能把普通调用提升为可信调用。 |
| `APPDATA` / `LOCALAPPDATA`、脚本直接读取、VM 控制路径 | 通用系统凭据和路径保护按目标系统择取。需要用户目录时使用可信执行端快照。未接通远端脚本读取时，该类检查列为未覆盖。UniClaw VM 专属路径暂不迁移。 | 不把控制进程的目录或 OS 当作容器、SSH 或 VM 的事实。 |
| Hermes 版本兼容 | 在插件清单与测试矩阵记录实际支持版本。发布时按已验证范围填写 `requires_hermes`。 | 以安装、注册、工具决策的实测行为为准。 |

## 文件与接口

下列文件位于拟创建的独立插件仓库。`rules/` 中保留迁入规则的来源与原规则 ID。若改变规则保护范围，在规则清单中登记变更后的语义和兼容关系。

| 文件 | 职责 |
|---|---|
| `plugin.yaml`、`__init__.py` | 声明 `pre_tool_call` 与配置。`register(ctx)` 只做注册。 |
| `hermes_adapter.py` | 将 Hermes 调用和可信上下文转换为内部操作。读取当前 profile 策略，返回 Hermes 指令。 |
| `guardrail/` | 内部操作模型、规则选择、检测器和决策。迁入模块使用包内导入，避免拉入 HexAgent/LangChain 运行时。 |
| `rules.md` | 每条规则的来源、目标环境、动作、启用条件、测试和未迁移原因。 |
| `tests/test_guardrail_policy.py`、`tests/test_hermes_integration.py` | 分别验证决策行为和真实 Hermes 加载、分发、阻断行为。 |

拟定内部接口为 `evaluate(action: Operation, context: ExecutionContext, policy: Policy) -> Decision`。`Operation` 含操作类型、原工具名、命令或完整目标路径集合。`ExecutionContext` 含适用规则所需的执行端 OS、Shell、最终 cwd、工作区和受保护路径。`Decision` 含 `ALLOW / DENY / ASK`、原因和规则 ID。可以在内部沿用现有 `RuntimeAction` 与 `PermissionDecision`，避免重复建模。宿主标识、配置和审批对象留在适配层。

## 实施步骤与验收

### 任务 1 · 用真实规则验证首个接入点（约 1 人天，计入下方总量）

- [ ] 确定部署 Hermes 版本、客户端、首个后端和 Shell。拟先用隔离的本地临时目录验证，不把该结果扩展到其他后端。把首批规则和各规则的阻断或审批动作写进 `rules.md`。
- [ ] 在独立插件目录注册 `pre_tool_call`。用 UniClaw 安装目录保护规则的判断逻辑，把临时目录中的指定子树作为 `protected_roots`。从真实 Hermes 工具分发调用 `write_file`。
- [ ] 验证插件发现和显式启用。命中时返回阻断原因且文件未创建或内容未变。未命中及相似前缀的正常路径可写。禁用插件后恢复 Hermes 自身的默认行为。
- [ ] 记录 `patch` 实际参数形态与终端实际 cwd/Shell 可获得性。若现有接口不足，先完成已覆盖路径，记录缺口对首期范围和工期的影响。

### 任务 2 · 迁移规则引擎及所需上下文

- [ ] 按 `rules.md` 抽取 `engine.py`、`baseline.py`、`matcher.py`、操作模型及选中规则依赖的检测器。从纯决策中移除产品环境读取，保留硬拒绝先于放行和审批的优先级。
- [ ] 为迁入规则移植代表性样例。用等价操作对照原规则 ID 和决策。测试硬拒绝不能被用户放行、会话放行或免询问覆盖。检查包可独立导入而无需启动 UniClaw。
- [ ] 从 profile 配置构造策略快照。缺少已启用规则所需的可信输入时，对约定受控的操作返回清楚的拒绝原因。未纳入首期的工具交回宿主，并在覆盖清单中列明。

### 任务 3 · 补齐工具映射与审批

- [ ] `write_file` 检查实际目标。`patch` 分别覆盖单路径和 V4A 正文，检查全部 Add、Update、Delete 路径以及 Move 的两端。多目标中任何一项命中硬拒绝时，阻断整个调用。畸形或无法识别目标的受控调用不得以空路径视为检查通过。
- [ ] `terminal` 使用实际 Shell 和后端 cwd，按受支持的命令语义选择规则。测试显式 `workdir`、会话 cwd 和默认 cwd 的优先级。通过无害测试命令和临时目录验证副作用，没有必要运行真实破坏命令。
- [ ] `DENY` 返回带可读理由的 `block`，`ASK` 返回 Hermes 原生 `approve`，`ALLOW` 返回 `None`。首期若开放可记忆审批，使用与规则和批准范围相符的键，避免按整个工具名放行。验证批准、拒绝、超时和无审批者的目标入口。
- [ ] 检查其他插件的参数改写与本插件判定顺序。当前 `pre_tool_call` 的 `modify` 结果在收集回调结果后合并。若受控调用实际执行的参数可能变化，按可复现的场景处理覆盖边界。发现缺口时，提交通用扩展提案，包含实际调用点、可选字段、旧回调兼容性和错误行为，再由插件使用。避免直接引用 `_resolve_command_cwd` 或 `_collect_v4a_header_paths` 等私有实现作为外部插件 API。

### 任务 4 · 回归与交付

- [ ] 用真实发现路径和临时 `HERMES_HOME` 验证发现、启停、命中与放行。以两个 profile 做 A→B→A 验证，确认策略和路径不会串用。涉及终端平台差异时在真实目标 OS 上验证。
- [ ] 验证回调异常或超时、插件未加载、配置不可用三种场景。当前 Hermes 对已注册的 `pre_tool_call` 回调异常和超时有阻断处理。插件未加载与宿主分发异常需分开验证。若生产要求强制防护，将插件加载状态纳入部署验收。
- [ ] 对可信插件代码执行 `hermes plugins doctor <插件目录> --ci`。按需要执行 `hermes plugins validate <插件目录>`，在 Hermes 仓库通过 `scripts/run_tests.sh` 跑受影响的测试。记录目标提交、后端、通过项目和未覆盖入口。
- [ ] 交付独立插件仓库、安装与启停说明、规则覆盖表和回退步骤。对照 Hermes 原有审批和工具检查验证正常路径。

## 排期与决策点

首期 Hermes 专用估算 **5–8 人天**。其中规则抽取 1–2 人天，Hermes 接线 2–3 人天，回归和交付 2–3 人天。若现在改成独立通用库，额外约 3–5 人天，用于跨宿主接口、打包和第二种调用方式验证。这些是基于静态分析的排期估算。若任务 1 发现通用接口缺口、目标后端额外增加或规则扩至全量，相关工作另估。

进入实现前需要落实的交付选择是目标客户端和后端、首批规则及审批动作、是否要求插件失效时停止受控工具执行。本文提出的是 Hermes 专用交付与局部参数化方案，实际安全策略以确认后的规则清单为准。

## 核对入口

- [Hermes 插件约束](../plugins/AGENTS.md) · [原生插件与中间件文档](../website/docs/developer-guide/plugins/index.md) · [工具钩子与审批](../hermes_cli/plugins.py) · [回调分发](../hermes_cli/plugins_dispatch.py) · [安全插件参考](../plugins/security-guidance/__init__.py)
- [工具执行路径](../agent/tool_executor.py) · [工具分发](../model_tools.py) · [终端 cwd](../tools/terminal_tool.py) · [V4A 补丁处理](../tools/file_tools.py)
- UniClaw 源码以 `libs/hexagent/hexagent/harness/guardrail/` 为根，重点核对 `contract.py`、`engine.py`、`normalizer.py`、`tool_schema.py`、`path_policy.py`、`baseline_rules/filesystem.py` 与 `detectors/shell/delete_exempt.py`。原规则测试位于 `libs/hexagent/tests/unit_tests/harness/guardrail/`。
