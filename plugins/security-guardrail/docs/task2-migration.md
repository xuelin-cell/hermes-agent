# 任务 2：引擎、资源与内部契约迁入记录

日期：2026-11-10。源版本 `c6a66bbf1abaddf4d12483ef66850adcebe528d2`。本任务完成插件内部引擎迁入；Hermes 工具接线和通用执行前 Hook 在任务 3～5 实施。

## 实际迁入内容

- 从 60 个源 Python 模块中迁入 57 个；安全中心 `configurable/` 的 3 个模块排除。
- 保留全部 138 条原基线规则的 ID、注册顺序、结果、类别、理由、产品规则组与 OS 条件；安装副本中的实际注册表与任务 1 来源清单逐项一致。
- 迁入规范化、匹配、Shell 语法、检测器、上下文必要部分和同步决策引擎。混合文件移除安全中心审计采集/字段及逐条 ASK 策略依赖，保留通用用户/会话规则功能。
- `catalog.json`、BetterLeaks 资源许可及 UniClaw 根许可与源 SHA-256 一致。资源通过 `files(__package__)` 加载，安装包被重命名后仍可读取。
- 新增 `contracts.py` 和 `guardrail/runtime.py`，分别承担宿主无关的请求/决策入口与每次调用的可信执行能力作用域。
- `plugin.yaml` 版本为 0.2.0，声明 `pydantic>=2,<3`。现有 PM 测试解释器含 Pydantic 2.13.4，满足范围；未运行 pip/uv、未新建或重装环境。仅验证了该已安装版本，不声称所有 Pydantic 2.x 版本均已实测。

逐源文件的目标、SHA-256 和全部 28 个原测试的处理说明见 [实际迁移结果](../../../docs/guardrail/evidence/phase2-task2/migration-result.json)。[迁移清单](migration-inventory.md) 仍保留源追溯关系。

## 内部调用契约

```python
from .contracts import GuardrailRequest, evaluate_tool_call
from .guardrail.types import OperatingSystem, PermissionMode

request = GuardrailRequest(
    tool_name="Write",  # 引擎原标准工具名；Hermes 工具映射在任务 4/5 实现
    args={"file_path": "D:/workspace/a.txt", "content": "hello"},
    profile=None,  # 仅通用规则，不默认假定 UniClaw PRO
    operating_system=OperatingSystem.WINDOWS,
    cwd="D:/workspace",
    workspace_root="D:/workspace",
    mode=PermissionMode.ASK,
    protected_roots=("D:/protected",),
)
decision = evaluate_tool_call(request)
```

结果为原 `PermissionDecision`，包含 ALLOW/DENY/ASK、规则 ID、来源、类别与理由。保护根有多个时按 DENY 优先于 ASK、ASK 优先于 ALLOW 聚合。空、相对路径、文件系统/盘符根、含点段或误传为单个字符串的保护根配置明确拒绝，不把它当作没有保护。宿主应先完成真实目标解析，契约只做无文件系统 I/O 的词法规范化与原策略可表达性校验。

请求还支持可信 `origin`、用户/会话规则、调用 ID 和 `RuntimeOperation`。操作类型与内容参数分开，使后续适配器能把 Delete 明确交给原删除规则。`cwd` 用于解析实际操作目标，`workspace_root` 用于判断工作区边界；在外部 workdir 创建相对文件不会因此把外部目录当作工作区。

`ExecutionEnvironment` 提供 APPDATA/LOCALAPPDATA、home、变量快照、文件存在/目录探测以及限额脚本读取。使用 ContextVar 仅绑定本次请求并在 finally 中恢复，没有导入时读取的账号/环境全局值。规则代码不导入 Hermes ctx、UniClaw ModelProfile、LangChain 或产品后端。

脚本读取回调接收执行端路径及最大读取字节数，原 1 MiB 上限另读 1 字节判断超限。没有回调、未知脚本 cwd/变量或内容超限时明确抛出 `ContextUnavailableError`；宿主适配器后续必须将其转换为阻断，不能继续执行。回调返回 None 表示宿主确认没有可读取的对应脚本，不在控制主机自行寻找同名文件。

未知存在性不能获得“只删除不存在文件”的豁免，未知目录不能取得工作区目录豁免。宿主能力不能从模型提交的 tool args 中获得。原 `execute_code -> Bash` 别名仅保留在源兼容层；后续 Hermes 适配器不能把 Python 执行工具直接套用这一别名。

## 语义保留与明确差异

保留的优先顺序：硬拒绝 → 原固定放行工具 → 可信来源 → 用户拒绝/允许 → 会话允许 → AUTO → ASK → 默认允许。ALLOW 不等于获得 Hermes 的全局授权；实际工具仍需宿主自己的检查。

| 项目 | 本次处理 |
|---|---|
| 安全中心逐条策略 | 明确排除。ASK 模式直接运行适用的原 ASK 基线；原版 ask_policy=None 时默认允许的情形，插件现在可能 ASK，这是已确认的策略承接差异。 |
| 安全中心审计 | 排除 audit_tool_input、PermissionAuditRecord、相关字段以及外部日志链路；系统审计服务保护检测器保留。 |
| UniClaw 环境及默认 PRO | 改为显式 profile、执行 OS、保护根和上下文输入；profile=None 只取通用组，环境变量不能替代可信输入。 |
| Skill 名推断特权 | 默认来源为普通 agent；不能仅凭工具名获得 builtin_skill 身份。宿主明确传入可信来源才使用原可信层逻辑。 |
| 产品路径与安装器豁免 | 原匹配逻辑保留，product_exemptions 默认 False；需可信调用者显式启用和提供对应执行端数据，不自动继承 UniClaw 例外。 |
| 文件/脚本探测 | 保留检测条件和限额，I/O 改为执行端能力回调；不能提供必需信息属于接入错误，不能解释为 ALLOW。 |
| cwd/工作区及删除类型 | 分开提供真实信息；不改危险操作检测条件，修正宿主输入无法表达原操作的问题。 |
| 敏感检测 | 保留独立 API、参数模型和资源；不新增自动外发过滤。SensitivePolicySnapshot 不是被排除的安全中心 AskPolicySnapshot。 |

为对照相同的 ASK 策略，参考源引擎为所有适用 ASK 规则配置 ASK，候选引擎直接执行 ASK 基线。176 组实际离线对照的行为、规则 ID、来源与类别完全一致；这不是在声称原版“未配置策略”也与候选一致。比较脚本和逐项结果见 [compare_source.py](../../../docs/guardrail/evidence/phase2-task2/compare_source.py) 与 [对照结果](../../../docs/guardrail/evidence/phase2-task2/source-decision-comparison.json)。危险命令仅作为字符串判断，未执行。

## 验证证据及范围

```bash
scripts/run_tests.sh tests/plugins/security_guardrail/ tests/plugins/test_security_guardrail.py --file-retries 0 -q -rx
```

本轮结果：16 个测试文件，1208 passed、1 skipped（POSIX）、1 xfailed（任务 1 已证明的参数改写缺口）。完整输出见 [final-tests.log](../../../docs/guardrail/evidence/phase2-task2/final-tests.log)。该缺口由任务 3 修复，本任务没有把它标为已解决。

只读审查发现：原内部契约会接受 `/`、盘符根和点段路径，但原保护策略无法正确表达。新增回归先观察 4 项失败，再补明确拒绝和词法规范化；最终完整回归通过。审查未发现 cwd/工作区传播、执行能力隔离或资源加载的其它已确认回归。实际工具映射、最终授权及审批执行作为后续任务范围，未用内部测试替代。

测试包括：迁入的原行为用例、覆盖全部适用 ASK 规则的原代表输入矩阵、匹配器/状态/优先级、内部请求、无效保护根、真实安装副本、脚本读取限额/缺信息、敏感合成数据、资源缺损及动态包名加载。另以隔离 Python 子进程阻止 hexagent、hermes_cli、model_tools、LangChain 导入，验证引擎与敏感 API 仍可运行。

原 28 个测试文件都有处理说明，但没有原样运行全部原测试矩阵：部分属于明确排除项，部分改为内部契约代表用例，源码扫描和易变数量断言不照搬；产品安装脚本、完整 MCP/sessions/安装器和公开接口边界矩阵仍需在后续校验中展开。不能以 1204 项通过代表所有安全效果已验证。

原生 Doctor 在临时 HERMES_HOME 中通过真实发现、导入和注册，见 [doctor.json](../../../docs/guardrail/evidence/phase2-task2/doctor.json)。Doctor 仍只看到原 Demo 的一个 pre_tool_call，未注册尚未实现的 pre_tool_execute。本机是 Windows；Linux/macOS 的显式 OS 输入只验证规则计算，不等于在那里执行了实际工具。

## 当前状态

任务 2 交付插件内部能力；当前桌面聊天仍走原 Demo 目录规则。任务 3 增加通用 Hook，任务 4/5 接通正式引擎与各类 Hermes 操作，任务 6 按能力覆盖表总验收。未修改 Hermes core、启动源码、C 盘用户配置或 UniClaw 源码，未提交/推送。
