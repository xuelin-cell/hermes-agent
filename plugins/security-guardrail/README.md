# security-guardrail

## 阶段二任务 2：引擎已迁入

插件内已迁入规则引擎、规范化器、匹配器、全部 138 条原基线规则以及独立敏感检测 API 和资源。
本次排除安全中心的页面、逐条规则设置、审计采集及其存储查询链路。来源、测试和已知差异见
[迁入记录](docs/task2-migration.md)。本次没有修改 Hermes core 或启动代码。

内部同步入口为 `contracts.evaluate_tool_call(request: GuardrailRequest) -> PermissionDecision`。
请求明确提供原标准工具参数、执行端 OS、产品规则组、最终 cwd、工作区根、保护目录及来源；
`profile=None` 仅选择通用规则，不根据 UniClaw 环境变量推断 PRO。其 `profile` 是规则产品组，
不等同于 Hermes 账号 profile。执行上下文的文件存在性、目录探测和限额脚本读取均由宿主注入。
缺少脚本读取能力、脚本过大或读取信息无效时抛出 `ContextUnavailableError`，后续宿主适配器必须阻断。
声明的运行依赖为 `pydantic>=2,<3`，经 Hermes PM 管理；当前测试复用已有符合范围的解释器环境。

敏感检测通过 `guardrail.sensitive_protection.inspect_sensitive_text(text, policy=...)` 独立调用，
按实际安装包名读取资源。输出包含原值，调用方不能把完整检测结果写入普通日志；本阶段不新增自动外发过滤。

保留的判断顺序是硬拒绝、固定放行、可信来源、用户拒绝/允许、会话允许、AUTO、ASK 和默认允许。
移除安全中心逐条设置后，ASK 模式直接执行适用的原 ASK 基线；这与原版未配置 `ask_policy` 时默认允许不同。
UniClaw 专用的产品目录/安装器等豁免默认关闭，只能在可信执行上下文中显式启用用于等价场景。

**当前聊天仍使用下述第一阶段目录规则。** 引擎与真实 Hermes 工具回调的接线、通用 `pre_tool_execute`
及完整审批对接属于任务 3～5；迁入引擎不表示这些工具已经受到新规则保护。

运行 `scripts/run_tests.sh tests/plugins/security_guardrail/ tests/plugins/test_security_guardrail.py` 验证内部引擎与现有 Demo。

## 当前执行中的第一阶段规则

第一阶段只验证本地文件后端的 `write_file` 执行前目录规则。命中规则时返回
`block`，Hermes 在实际写入前结束该工具调用。普通路径继续进入原工具检查。

## 配置与启用

在当前 profile 的 `config.yaml` 中合并以下设置，保留已有插件与其他设置。
`protected_directory` 必须是绝对本地路径，例如一个专门用于验证的目录。

```yaml
plugins:
  entries:
    security-guardrail:
      settings:
        protected_directory: 'D:\liantong\projects\python\hermes-agent\.hermes\security-check\protected'
```

通过同一 profile 的 CLI 执行 `hermes plugins enable security-guardrail`，然后在
对应桌面后端重启或新建会话，确认插件已加载。插件依赖本次新增的
`ctx.resolve_file_path()`，部署需包含该通用接口的 Hermes 版本。

配置在调用时读取，按当前 profile 生效。已启用但配置缺失、路径无法解析时，
拒绝 `write_file` 并说明原因。目录不必预先存在，子目录同样受保护。

## 验证

运行 `scripts/run_tests.sh tests/plugins/test_security_guardrail.py`。
测试使用临时 profile、真实插件发现和 `model_tools.handle_function_call()`，
正常路径通过真实文件后端写入。验证创建阻断、已有文件字节与修改时间不变、
相对路径、目录跳转、相似前缀、Windows 大小写和 junction，以及 A→B→A 配置隔离。
POSIX 的符号链接用例在对应 OS 上运行。

桌面手工复验时，分别要求模型调用 `write_file` 向受保护目录和其旁边普通目录
写入一个测试文件，核对实际工具名称、阻断原因和磁盘结果。再对保护目录的现有
测试文件请求覆盖，确认原字节和修改时间未变。只有模型确实调用 `write_file`
的结果才属于本阶段验证。

## 覆盖范围

路径通过 `ctx.resolve_file_path()` 采用文件工具的任务 cwd、profile home 与后端
规则，再在本地解析链接并按目录归属匹配。Windows 使用原生大小写语义。
当前对网络路径、容器及 SSH 后端的 `write_file` 返回不支持提示。

`patch`、终端、MCP 和其他写入渠道尚未接入。链接在检查后被并发替换、其他插件在
后续改写工具参数等场景需要后续执行边界验证。本插件用于第一阶段链路验证，
完整 Guardrail 规则迁入、其他工具覆盖和部署防护属于后续阶段。
