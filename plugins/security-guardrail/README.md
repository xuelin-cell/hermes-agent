# security-guardrail

当前版本 0.3.0：真实 Guardrail 引擎通过通用 `pre_tool_execute` 接入 Hermes。第一阶段 Demo 已移除，原有 `protected_directory` 配置继续可用。规则/资源来源见 [任务 2 记录](docs/task2-migration.md)，逐项适配状态见 [覆盖表](docs/capability-matrix.md)，本轮实现与限制见 [任务 3～5 记录](docs/task3-5-adaptation.md)。

## 配置

在拥有该会话的 Hermes profile 的 `config.yaml` 中合并下列配置，保留其他设置。插件是内置 Python 插件，不新增桌面管理页面。

```yaml
plugins:
  enabled:
    - security-guardrail # 与已有 enabled 项合并
  entries:
    security-guardrail:
      settings:
        protected_directory: 'D:\liantong\projects\python\hermes-agent\.hermes\security-check\protected'
        protected_roots: []
        mode: ask
        build_profile: common
        user_rules: []
```

至少配置一个绝对本地保护目录；目录、模式或规则配置无效时拒绝执行。保护根复用源 product_install_dir_access，覆盖读取、写入及 Shell 路径引用。`mode=ask` 使用原 ASK 基线和 Hermes 原生审批；`auto` 跳过 ASK，硬拒绝仍生效。Hermes 原生审批自身的无人值守/单次查询/自动批准配置继续适用。

`build_profile` 选择源规则组：`common`、`lite`、`pro`、`server`，不表示 Hermes 账号或执行端；不能根据名称认定正在 VM 内。默认 common；138 条规则定义全部保留，但每次只选适用的规则。UniClaw 产品路径和可信安装器等豁免默认关闭。

`user_rules` 保留源用户规则的 allow/deny 语义，例如 `{tool: Write, pattern: '**/generated/**', behavior: allow}`。工具名使用源标准名；硬拒绝和原固定放行顺序不变。可信宿主可以调用 `adapters.policy.allow_session(profile_scope, session_id, tool_name, pattern='')` 设置内存允许规则；会话结束或插件卸载清除。此接口不作为模型工具暴露。

## 执行链

`模型调用 → 参数 Hook/请求中间件 → 执行中间件 → 宿主准备最终输入 → pre_tool_execute → DENY / 原生 ASK / ALLOW → 执行`。

文件、补丁、终端和 URL 工具在准备位置授权；其余注册表工具、连接器与 Agent 内联入口使用同一通用最终分发。快照只读，最终 Hook 不接受 modify；任何拒绝优先于审批。异常、超时、无效返回拒绝执行。批准键绑定实际参数、目标、cwd、工作区、OS/Shell、profile/会话与策略；脚本检查摘要也进入插件授权键。

已接入 write_file、replace/V4A Add/Update/Delete/Move、read_file/search_files、本地 Bash 前后台及字面路径脚本、Web 查询和逐 URL 检查、用户/会话规则及对应数据工具。具体入口和证据须查看覆盖表，不能据此称所有写入渠道都受到文件保护。

## 限制

- Windows 本地后端为本轮验证环境。映射文件/终端若执行端信息不明，直接拒绝；不把 SSH、容器认成本机。其他 OS 的规则与测试保留，未伪造平台验证。
- Windows Bash 支持本机绝对路径、MSYS 盘符路径和已有本地链接解析。无法确认的虚拟根/设备/网络路径拒绝；`/dev/null` 保留其空设备语义。
- 持久 Bash 环境可被此前命令改变，初始 HOME 等不是最终事实。目前仅确认字面脚本路径；依赖 `$HOME`、`~` 等环境展开的脚本拒绝，待宿主提供可靠的持久环境快照后扩展。
- V4A 整批在首次修改前判断。移动链接后继续操作其受影响路径的复杂顺序补丁拒绝，要求拆为两次工具调用；普通文件 Move 后 Update 仍支持。不能保证外部进程在检查后更换链接的并发竞态。
- Hermes execute_code 运行 Python，不能套源 Bash 别名。目前按未知执行字段规则拒绝，不代表已分析 Python 副作用。交互进程 stdin、网页交互/重定向和模型之外的 UI 路由不自动具有同等防护。
- “设置－安全中心”、逐条规则设置、审计采集/存储/查询/UI 均未迁移。独立敏感检测 API 保留可调用，不自动挂到发送或外发工具。

## 验证

```bash
scripts/run_tests.sh tests/plugins/security_guardrail/ tests/plugins/test_security_guardrail.py tests/plugins/test_security_guardrail_patch.py tests/plugins/test_security_guardrail_terminal.py tests/plugins/test_security_guardrail_other_tools.py tests/plugins/test_security_guardrail_policy.py tests/hermes_cli/test_plugins_execution.py tests/agent/test_final_execution_policy.py
```

桌面复验需完整重启后端并新建日常聊天会话，确认加载新版本；仅启动已在运行的前端不会替换旧进程中的插件。依次验证保护目录写入/覆盖、普通目录写入、补丁混合目标拒绝、终端保护路径拒绝、工作区外 ASK 批准/拒绝。检查实际工具名和磁盘结果。无需改启动源码或重装环境；本轮没有修改活动账号配置。任务 6 仍负责完整安装、客户端/cron/子 Agent 的最终验收。
