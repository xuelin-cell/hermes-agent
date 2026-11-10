# 任务 3～5 验证记录

日期：2026-11-10。代码基线 9c2539b2ed；本轮未提交。Windows / PowerShell / Git Bash；复用已有 PM test-environment Python 3.14，不重装环境、不改活动账号配置。所有 Python 测试均经 scripts/run_tests.sh；未使用 bare pytest。

## 执行入口

```powershell
$env:HERMES_PYTHON='/d/liantong/projects/python/hermes-agent/.hermes/windows-activation/data/installs/e4df25ac6f432167/test-environment/gen-384d282ffd9a46cc881052663c52cd7e/venv/Scripts/python.exe'
$env:HERMES_TEST_WORKERS='4'
& 'D:/Program Files/Git/bin/bash.exe' scripts/run_tests.sh <日志首部列出的测试路径> --file-retries 0 -q
```

最终集中命令包含迁入规则目录、当时全部 security_guardrail 真实适配测试、通用 Hook、Agent 内联入口、registry、terminal、approval、Tool Search、连接器本地解包和 web_extract robustness。最终集中结果：30 个文件，1345 passed / 0 failed / 2 skipped（本机跳过 POSIX 测试），见 final-tests.log。附加最终适配验证 final-adapters.log 为 20 passed / 0 failed / 1 skipped；临时 profile 安装副本及错误补丁追加验证为 7 passed / 0 failed / 2 skipped，见 installed-copy-tests.log。

## 先失败后接线的证据

- write_file 后置改参：任务 1 已真实复现 XFAIL；本轮移除 xfail，真实重写后保护文件不创建。
- terminal：未接线时普通 printf 成功写入保护测试目录；接线后前后台同样输入阻断，普通目录仍真实可写。
- patch：未接线时 protected/existing.txt 实际被 replace；接线后整组 Add/Update/Delete/Move 拒绝不留下首笔修改。
- inline memory：接线前新增最终 veto 不影响真实 USER.md 写入；接线后线程、串行入口均拒绝不落盘，允许后真实保存。
- 独立审查的纯决策探针确认 MSYS 同目标原生路径 DENY、/d 路径 ALLOW，以及初始 HOME 与实际 HOME 的脚本判定不同；对应修复与新回归见 review-fixes-tests.log / final-adapters.log。

## 独立审查及处理

执行计划技能要求的一次只读审查提出 4 个 P1：

1. V4A Move 链接再 Update 的同批顺序副作用：在首修改前识别受影响依赖并整批拒绝。普通文件 Move→Update 仍真实执行通过；Windows junction 用例已验证，POSIX 文件 symlink 用例因平台跳过。
2. Windows Bash 的 MSYS 盘符：宿主提供执行端 resolve_path；注入 source normalizer/workspace/script 规范化，保持未注入时原行为。native 与 MSYS 目标同硬拒绝。
3. shell snapshot 环境与初始 env 不一致：终端不再用初始 HOME/APPDATA 等作为脚本展开依据，缺最终事实即拒绝；未宣称支持持久环境变量脚本等价放行。
4. terminal 稳定链接别名：经执行端路径能力检查真实目标，Windows junction 真实拒绝；未把稳定别名问题留作并发 TOCTOU。

此外，最终执行 cwd 独立传递，避免改变 workdir 原有“临时目录”语义。文件执行 cwd 记录与配置/注册的 workspace_root 分开。读取原规则和独立安装 API 的回归继续保留。

## 广泛回归与既有失败

最初广泛回归：[regression.log](regression.log)，1420 passed / 12 failed / 6 skipped（16 workers）。随后网页/分发回归：[dispatch-web-tests.log](dispatch-web-tests.log)，37 passed / 2 failed。

为排除迁移影响，使用 `git archive HEAD` 在 `.pytest_cache/guardrail-task3-5-baseline` 解出独立只读基线测试树，保持当前工作区代码不变，使用同一测试 Python 和 runner：

- [baseline-regression.log](baseline-regression.log)：4 文件，144 passed / 11 failed / 6 skipped。
- [baseline-dispatch-web.log](baseline-dispatch-web.log)：2 文件，30 passed / 2 failed。

确认 13 个既有失败：portable plugin 的 darwin 位置断言 1、文件 cwd/Windows 路径与链接断言 4、文件系统保护路径断言 4、本地 shell cat/tilde 2、浏览器路由 1、固定 mtime 的 config cache 1。未修改这些测试或对应业务来凑全绿。初次重负载下额外 echo 探测超时在随后 4-worker 原文件复验通过；它不属于 13 个稳定基线失败。

最终集中通过不等于全仓库通过。日志保留失败分类，不混淆已知基线、平台跳过与新增适配结果。

## 验证限制

本轮不使用生产模型/凭据，不重启桌面，不访问公网 Provider。网页 ALLOW 使用经 PluginContext 注册的本地 Provider，DNS 安全判断由测试边界替换；其余加载、URL 规范化、策略、分发、缓存和真实 web handler 均运行。委派验证止于 Agent 宿主回调及其拒绝，不启动真实模型子任务。澄清使用本地宿主回答回调，不代表桌面 UI 已验。

本轮已验证候选副本复制到临时 profile 后由该副本加载并实际阻断；完整安装/依赖同步、Doctor、桌面/Gateway/cron/真实模型子 Agent 端到端总验收仍属于任务 6。也没有宣称所有写入渠道、安全效果或跨平台已完成。限制和无等价入口见 plugins/security-guardrail/docs/capability-matrix.md。
