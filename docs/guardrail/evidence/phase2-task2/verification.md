# 任务 2 验证与执行记录

日期：2026-11-10；Hermes 基线 05b4b81558，UniClaw 基线 c6a66bbf。用户授权执行任务 2，任务 3～6 尚未实施。

## 实施与核验

- 迁入 57 个范围内源模块、2 个资源和源根许可。全部 138 条注册规则元数据与源快照一致。逐源文件目标及哈希见 migration-result.json，新增模块为插件 contracts.py、guardrail/runtime.py。
- 排除 configurable 的 3 个模块、安全中心审计类型/字段、ModelProfile 和产品环境解析。混合模块保留可独立运行的通用行为。产品路径、安装器和脚本能力改为显式输入，不读进程环境或在控制主机猜测远端文件。
- 包内绝对导入转为相对导入，敏感资源按实际安装命名空间加载；原始来源哈希保存在任务 1，导入转换后的早期目标快照见 copy-baseline.json（其中包含新增 runtime，不替代源哈希）。
- Pydantic 依赖通过 manifest 声明，使用已存在的 PM 测试解释器 2.13.4 包版本，未安装/升级依赖。解释器和 Doctor 详细输出见 doctor.json。

## 测试过程

1. 先写独立安装契约测试；迁入前明确断言失败 `Candidate has no migrated engine contract`，确认能发现缺少引擎而非只测试旧 Demo。
2. 迁入原行为测试，识别并修正换行、源测试依赖产品工具类、显式脚本 cwd 和 Hermes 临时 home 夹具差异。初始与中间测试日志保留用于溯源，不是最终状态。
3. 迁入原 30 条 ASK 代表输入，覆盖适用产品组及 ASK/AUTO；增加工作区、可信来源、优先级、删除语义、缺失脚本能力和资源缺损测试。
4. 隔离 Python 子进程以任意安装包名加载全部模块，并禁止 hexagent/hermes_cli/model_tools/langchain 导入，仍能运行引擎与敏感检测 API。敏感资源缺失和无效内容有真实失败测试。
5. 对原固定源版本做 176 组实际离线决策对照，行为、规则 ID、来源、类别一致；原版配置所有适用 ASK 规则为 ASK 后与插件直接 ASK 比较。原版未配置策略的差异另外记录，不能据此说所有默认策略完全一致。

## 独立代码审查

按 requesting-code-review 技能安排只读审查。发现 1 项 P2：保护根虽然是绝对路径，但 `/`、`C:/` 或包含点段的边界不被原策略正确表达，可能变成 ALLOW。先扩展回归观察 4 项真实失败（review-root-validation-red.log），再增加原策略可表达性校验、拒绝点段/文件系统根及词法规范化。最终完整回归通过。

审查未确认工作区传播、执行能力隔离或包资源加载的其它回归。审查暂不判断实际 Hermes 工具映射、最终执行授权、原生审批执行及 Demo 替换，因为它们分别属于任务 3～5；这些项继续是第二阶段总验收的必做项，没有被排除。

## 最终结果

```bash
scripts/run_tests.sh tests/plugins/security_guardrail/ tests/plugins/test_security_guardrail.py --file-retries 0 -q -rx
```

16 个文件，1208 passed、0 failed、1 skipped（POSIX）、1 xfailed（已知参数改写缺口）。最终日志 final-tests.log。原生 Doctor 通过声明、真实发现、导入和注册，输出 doctor.json。执行命令使用 D 盘现有 Git Bash 与独立 PM 测试解释器；测试中的危险命令均作为字符串解析，未执行。

全部 28 个源测试文件都有处理去向，但未照搬或运行所有原产品矩阵。对安全中心测试明确排除；对产品安装脚本、性能、完整 sessions/MCP/安装器、重定向及公开接口边界矩阵分别登记代表性替换或后续校验，见 migration-result.json。1208 项通过不代表所有原测试已运行，也不代表真实工具防护已接通。

Task 2: complete — 源模块/资源/许可迁入、内部调用契约、显式宿主能力、原规则语义对照及相关测试完成；未提交或推送。

Task 2: Ruling: 按已确认附件直接承接 ASK 基线；原版无 ask_policy 默认允许与插件 ASK 可能询问的差异已明确，不把它作为无意回归。

Task 2: Ruling: 现有 Pydantic 2.13.4 已符合声明，通过独立进程测试确认；不为“准备环境”重装现用依赖。其它 2.x 版本未实测。

Task 2: Ruling: 独立 API/引擎基础验证与宿主集成分开；现有 register(ctx) 仍是 Demo，已知参数改写 xfail 不在本任务中修复，必须由任务 3 消除。若误将本轮结果当成全工具已防护，会超出证据范围。

Task 2: fixed review finding — unrepresentable protection roots; invalid-root tests RED（4 failed）→ GREEN，完整相关回归 1208 passed。

下一任务输入：已迁入 contracts/engine/runtime、能力覆盖表、原参数改写回归及本记录。下一任务实现通用 pre_tool_execute，随后连接正式适配器。真实用户配置、Hermes core/启动源码和 UniClaw 源码未变。
