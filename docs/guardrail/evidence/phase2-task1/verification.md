# 阶段二任务 1：基线、复现与实施记录

日期：2026-11-10。执行范围为第二阶段计划的任务 1，尚未复制 Guardrail 引擎、实现通用 Hook 或更改运行账号配置。

## 来源与环境

- Hermes HEAD：05b4b8155831d7e7df0df3e81e7980c338b6a09c。
- UniClaw 源提交完整值、93 个来源文件哈希、符号与规则信息见 [source-manifest.json](source-manifest.json)。已核查源 Guardrail、原测试和许可证的 git 跟踪文件无未提交修改；没有把本地未跟踪文件当成源版本内容。
- Windows 本机真实运行；测试解释器沿用 D 盘既有 PM 独立测试环境：`.hermes/windows-activation/data/installs/e4df25ac6f432167/test-environment/gen-384d282ffd9a46cc881052663c52cd7e/venv/Scripts/python.exe`。
- 测试启动 Shell：`D:/Program Files/Git/bin/bash.exe`；通过 `HERMES_PYTHON` 指向上述测试环境，未安装或重建依赖。测试遵循仓库 runner 的临时 HERMES_HOME、无凭据环境、每文件进程隔离。
- 源盘点复核：60 个 Python、2 个资源、28 个 test_*.py、138 条规则；规则族 Shell 112、文件 11、工具 7、网络 2、数据 6；硬拒绝 108、ASK 30。规则 tier 为 common 120、lite 7、pro 11。
- 93 项包括上述 62 个引擎/资源文件、28 个测试、1 个源测试包标记、1 个合成 fixture、1 个根许可。仅载入源规则元数据，不代表 UniClaw 原应用和全部原测试已运行。

## 当前插件基线

在增加回归前运行：

```bash
scripts/run_tests.sh tests/plugins/test_security_guardrail.py -q
```

结果：3 passed，0 failed，1 skipped（POSIX 符号链接用例在 Windows 正常跳过）。真实文件写入、保护路径拒绝、既有内容与修改时间保持、普通路径成功、A→B→A 以及 Windows 大小写/junction 验证通过。

## 已知缺口的真实失败证据

新增 `test_rewritten_protected_target_is_blocked`，重用真实 PluginManager 加载 Demo，通过公开 PluginContext 注册另一个返回 modify 的回调，不 mock 工具执行。输入为普通路径，第二个回调把目标改为临时 protected/rewritten.txt。

```bash
scripts/run_tests.sh tests/plugins/test_security_guardrail.py -k test_rewritten_protected_target_is_blocked --runxfail --file-retries 0 -q
```

实际结果：退出码 1，1 failed、4 deselected。工具未返回错误，目标文件真实存在，内容为合成标记 `rewrite-gap-probe`，触发：

```text
FileExistsError: The rewritten protected target was actually written
```

根因位置：`hermes_cli/plugins.py::_get_pre_tool_call_directive_details` 在执行各回调后汇总 modify，目录护栏检查的是旧参数；`model_tools.py::_pre_dispatch_guards` 返回修改后的参数继续执行。此结果证明当前 Demo 不具备“所有参数改写之后”的最终授权，不能靠更改钩子注册顺序修复。

此测试标记 `xfail(strict=True, raises=FileExistsError)`，只允许上述已证明的失败：若工具报环境错误或断言失败仍会报失败。新 Hook 修好后严格 XPASS 将提示移除 xfail 标记并把它转为正常通过的回归。任务 3 必须让原用例通过，不能仅删除此证据。

## 新增回归后的基线

```bash
scripts/run_tests.sh tests/plugins/test_security_guardrail.py -q -rx --file-retries 0
```

完整 runner 输出见 [hermes-baseline.log](hermes-baseline.log)。结果：3 passed、1 skipped、1 xfailed（行内 `1xf`）；退出码 0。预期失败不等于安全问题已解决，也不计入第二阶段通过项。

## 任务记录与后续输入

Task 1: complete — 来源与排除清单、138 条规则及全部 35 个源标准工具去向均已登记；基线通过，已知缺口已实际复现并保留回归。没有提交或推送。

Task 1: Ruling: 本轮执行用户所说“第一步”，对应已确认计划的任务 1；不把“完整适配”的总目标误报为本轮已经完成。任务 2 起才迁入引擎。

Task 1: Ruling: 先以严格、限定异常类型的 xfail 保留已知缺口，不在盘点任务中夹带宿主修复；代价为缺口仍在，必须由任务 3 消除且继续阻塞阶段二最终通过。

注意源测试存在读取 UniClaw 安装脚本/后端源码的断言，任务 2 必须改成实际行为测试；不按原样复制这些断言。源测试的直接规则 ID 引用只是定位线索，不代表已经运行或具备完整覆盖。

输出位置：`plugins/security-guardrail/docs/migration-inventory.md`、`capability-matrix.md`。下一任务输入为以上清单、快照和回归，不另行猜测迁移范围。
