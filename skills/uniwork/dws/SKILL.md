---
name: dws
description: "管理钉钉消息、文档、日程、待办、审批和组织能力."
version: "1.0.0"
author: "UniWork"
license: Proprietary
platforms: [linux, macos, windows]
tags: [钉钉, 协作, 办公]
cli_version: ">=1.1.0"
---

# 钉钉全产品 Skill

通过 `dws` 命令管理钉钉产品能力。

## 初始化检查流程

**重要**: 在执行任何 dws 命令前，必须按以下顺序检查并完成初始化。

**首先检测操作系统**：
- Linux/macOS: 使用 `sh install.sh` 和 `sh auth.sh`
- Windows: 使用 `.\install.ps1` 和 `.\auth.ps1`

---

### Linux/macOS 环境

#### Step 1: 检查并安装 dws

```bash
# 检查 dws 命令是否存在
which dws || command -v dws
```

- 如果返回路径，说明已安装，跳到 Step 2
- 如果返回空或报错，执行本地安装：

```bash
# 本地安装（无需网络，从 skill 自带的 tar.gz 安装）
sh <skill-dir>/scripts/install.sh

# 或指定架构强制安装
sh <skill-dir>/scripts/install.sh --arch amd64  # x86_64
sh <skill-dir>/scripts/install.sh --arch arm64  # aarch64
```

安装后确认 PATH：
```bash
export PATH="$HOME/.local/bin:$PATH"
dws version
```

**支持的架构**:
- `amd64` - x86_64 / x64 架构
- `arm64` - aarch64 / ARM64 架构

#### Step 2: 检查鉴权状态

```bash
# 使用 auth.sh 脚本检查鉴权状态
sh <skill-dir>/scripts/auth.sh --check
```

- 如果显示 `AUTHENTICATED` → 初始化完成，可正常使用
- 如果显示 `NOT AUTHENTICATED` → 执行 Step 3

#### Step 3: 设备流鉴权登录

**适用于 Linux 虚机/服务器等无浏览器环境**

> ⚠️ **禁止直接使用 `dws auth login` 命令！必须使用 auth.sh 脚本进行鉴权。**

```bash
# 执行鉴权脚本，自动启动设备流登录
sh <skill-dir>/scripts/auth.sh
```

脚本会自动：
1. 检查 dws 是否已安装
2. 检查当前鉴权状态（已认证则跳过）
3. 启动后台设备流登录进程
4. 输出授权链接和授权码供用户使用

**鉴权操作流程（必须严格遵守）**:

1. **执行 auth.sh 脚本**
   ```bash
   sh <skill-dir>/scripts/auth.sh
   ```

2. **等待脚本输出授权链接**（脚本会自动后台等待）

3. **将授权链接展示给用户**
   - 告知用户："请在浏览器中打开以下链接并完成钉钉扫码授权："
   - 展示脚本输出的完整链接

4. **等待用户反馈**
   - 使用 AskUserQuestion 工具询问用户是否已完成授权
   - 等待用户确认

5. **验证鉴权状态**
   ```bash
   sh <skill-dir>/scripts/auth.sh --check
   ```
   - 显示 `AUTHENTICATED` → 鉴权成功，可继续使用 dws 命令
   - 显示 `NOT AUTHENTICATED` → 重新执行 Step 3

**禁止行为**:
- ❌ 禁止执行 `dws auth login --device`
- ❌ 禁止执行 `dws auth login`
- ❌ 禁止跳过用户授权确认环节
- ❌ 禁止假设授权已成功而不验证

---

### Windows 环境

#### Step 1: 检查并安装 dws

```powershell
# 检查 dws 命令是否存在
Get-Command dws -ErrorAction SilentlyContinue
```

- 如果返回路径，说明已安装，跳到 Step 2
- 如果返回空或报错，执行本地安装：

```powershell
# 本地安装（无需网络，从 skill 自带的 zip 安装）
. <skill-dir>\scripts\install.ps1

# 或指定架构强制安装
. <skill-dir>\scripts\install.ps1 -Arch amd64  # x64
. <skill-dir>\scripts\install.ps1 -Arch arm64  # ARM64
```

安装后确认 PATH：
```powershell
# 临时添加到当前会话
$env:PATH = "$env:USERPROFILE\.local\bin" + [System.IO.Path]::PathSeparator + $env:PATH

# 永久添加到 PowerShell 配置文件（推荐）
# 1. 打开配置文件: notepad $PROFILE
# 2. 添加以下行:
#    $env:PATH = "$env:USERPROFILE\.local\bin" + [System.IO.Path]::PathSeparator + $env:PATH

dws version
```

**支持的架构**:
- `amd64` - x86_64 / x64 架构
- `arm64` - aarch64 / ARM64 架构

#### Step 2: 检查鉴权状态

```powershell
# 使用 auth.ps1 脚本检查鉴权状态
. <skill-dir>\scripts\auth.ps1 -Check
```

- 如果显示 `AUTHENTICATED` → 初始化完成，可正常使用
- 如果显示 `NOT AUTHENTICATED` → 执行 Step 3

#### Step 3: 设备流鉴权登录

**适用于 Windows 服务器/无浏览器环境**

> ⚠️ **禁止直接使用 `dws auth login` 命令！必须使用 auth.ps1 脚本进行鉴权。**

```powershell
# 执行鉴权脚本，自动启动设备流登录
. <skill-dir>\scripts\auth.ps1
```

脚本会自动：
1. 检查 dws 是否已安装
2. 检查当前鉴权状态（已认证则跳过）
3. 启动后台设备流登录进程
4. 输出授权链接和授权码供用户使用

**鉴权操作流程（必须严格遵守）**:

1. **执行 auth.ps1 脚本**
   ```powershell
   . <skill-dir>\scripts\auth.ps1
   ```

2. **等待脚本输出授权链接**（脚本会自动后台等待）

3. **将授权链接展示给用户**
   - 告知用户："请在浏览器中打开以下链接并完成钉钉扫码授权："
   - 展示脚本输出的完整链接

4. **等待用户反馈**
   - 使用 AskUserQuestion 工具询问用户是否已完成授权
   - 等待用户确认

5. **验证鉴权状态**
   ```powershell
   . <skill-dir>\scripts\auth.ps1 -Check
   ```
   - 显示 `AUTHENTICATED` → 鉴权成功，可继续使用 dws 命令
   - 显示 `NOT AUTHENTICATED` → 重新执行 Step 3

**禁止行为**:
- ❌ 禁止执行 `dws auth login --device`
- ❌ 禁止执行 `dws auth login`
- ❌ 禁止跳过用户授权确认环节
- ❌ 禁止假设授权已成功而不验证

---

### 脚本说明

#### Linux/macOS: install.sh 安装脚本

| 用法 | 说明 |
|------|------|
| `sh install.sh` | 自动检测架构并安装 |
| `sh install.sh --arch amd64` | 强制安装 amd64 版本 |
| `sh install.sh --arch arm64` | 强制安装 arm64 版本 |
| `sh install.sh --help` | 显示帮助信息 |

**环境变量**:
- `DWS_INSTALL_DIR`: 安装目录 (默认: `~/.local/bin`)

**本地安装包**: `scripts/dws-linux-amd64.tar.gz` 和 `scripts/dws-linux-arm64.tar.gz`

#### Linux/macOS: auth.sh 鉴权脚本

| 用法 | 说明 |
|------|------|
| `sh auth.sh` | 启动设备流鉴权登录 |
| `sh auth.sh --check` | 仅检查鉴权状态，不执行登录 |
| `sh auth.sh --help` | 显示帮助信息 |

**环境变量**:
- `DWS_AUTH_LOG_DIR`: 鉴权日志目录 (默认: `/sessions/$USER`)
- `DWS_AUTH_TIMEOUT`: 等待授权链接的超时秒数 (默认: 30)

#### Windows: install.ps1 安装脚本

| 用法 | 说明 |
|------|------|
| `.\install.ps1` | 自动检测架构并安装 |
| `.\install.ps1 -Arch amd64` | 强制安装 amd64 版本 |
| `.\install.ps1 -Arch arm64` | 强制安装 arm64 版本 |
| `.\install.ps1 -Force` | 强制重新安装 |
| `.\install.ps1 -Help` | 显示帮助信息 |

**环境变量**:
- `$env:DWS_INSTALL_DIR`: 安装目录 (默认: `$env:USERPROFILE\.local\bin`)

**本地安装包**: `scripts/dws-windows-amd64.zip` 和 `scripts/dws-windows-arm64.zip`

#### Windows: auth.ps1 鉴权脚本

| 用法 | 说明 |
|------|------|
| `.\auth.ps1` | 启动设备流鉴权登录 |
| `.\auth.ps1 -Check` | 仅检查鉴权状态，不执行登录 |
| `.\auth.ps1 -Status` | 同 -Check |
| `.\auth.ps1 -Help` | 显示帮助信息 |

**环境变量**:
- `$env:DWS_AUTH_LOG_DIR`: 鉴权日志目录 (默认: `$env:USERPROFILE\.dws\sessions`)
- `$env:DWS_AUTH_TIMEOUT`: 等待授权链接的超时秒数 (默认: 30)

---

### 初始化失败处理

| 问题 | 解决方案 |
|------|----------|
| 找不到安装包 | Linux: 检查 `scripts/dws-linux-*.tar.gz` 是否存在<br>Windows: 检查 `scripts/dws-windows-*.zip` 是否存在 |
| 架构不匹配 | 使用 `--arch` / `-Arch` 参数指定正确架构 |
| 写入权限不足 | Linux: 检查对 `~/.local/bin` 的写入权限<br>Windows: 检查对 `$env:USERPROFILE\.local\bin` 的写入权限 |
| 鉴权超时 | Linux: 检查 `$DWS_AUTH_LOG_DIR/dws_auth.log` 日志<br>Windows: 检查 `$env:DWS_AUTH_LOG_DIR\dws_auth.log` 日志 |
| Token 解密失败 | 执行 `dws auth reset` 后重试 |
| 详细错误信息 | 执行 `dws auth login --device --verbose` |

## 严格禁止 (NEVER DO)
- 不要使用 dws 命令以外的方式操作（禁止 curl、HTTP API、浏览器）
- 不要编造 UUID、ID 等标识符，必须从命令返回中提取
- 不要猜测字段名/参数值，操作前必须先查询确认
- **禁止直接执行 `dws auth login` 或 `dws auth login --device`**
  - Linux/macOS: 必须使用 `sh <skill-dir>/scripts/auth.sh` 脚本
  - Windows: 必须使用 `.\ <skill-dir>\scripts\auth.ps1` 脚本
- **禁止跳过用户授权确认**，鉴权脚本输出授权链接后必须等待用户反馈完成授权

## 严格要求 (MUST DO)
- 所有命令必须加 `--format json` 以获取可解析输出
- 危险操作必须先向用户确认，用户同意后才加 `--yes` 执行
- 单次批量操作不超过 30 条记录
- 所有命令必须**严格遵循**对应产品参考文档里面规定的参数格式（如：如果有参数值，则参数和参数值之间至少用一个空格隔开）
- **鉴权必须使用对应平台的脚本**：
  - Linux/macOS: 执行 `sh <skill-dir>/scripts/auth.sh` 启动设备流登录
  - Windows: 执行 `. <skill-dir>\scripts\auth.ps1` 启动设备流登录
- **必须等待用户授权反馈**：鉴权脚本输出授权链接后，必须将链接展示给用户并等待用户确认完成授权
- **授权后必须验证状态**：用户确认授权后验证鉴权成功
  - Linux/macOS: 执行 `sh <skill-dir>/scripts/auth.sh --check`
  - Windows: 执行 `. <skill-dir>\scripts\auth.ps1 -Check`


## 产品总览

| 产品                | 用途                                                   | 参考文件                                                           |
|-------------------|------------------------------------------------------|----------------------------------------------------------------|
| `aitable`         | AI表格：表格/数据表/字段/记录增删改查/模板搜索                           | [aitable.md](./references/products/aitable.md)                 |
| `approval`        | 审批：审批表单/发起实例/审批/撤销                                   | [simple.md](./references/products/simple.md)                   |
| `attendance`      | 考勤：打卡记录/排班查询                                         | [attendance.md](./references/products/attendance.md)           |
| `calendar`        | 日历：日程/参与者/会议室/闲忙查询                                   | [calendar.md](./references/products/calendar.md)               |
| `chat`            | 群聊与机器人：搜索群/建群/群成员管理/改群名/机器人群发/单聊/撤回/Webhook/机器人搜索     | [chat.md](./references/products/chat.md)                       |
| `contact`         | 通讯录：用户查询(当前用户/搜索/详情)/部门查询(搜索/子部门/成员列表)               | [contact.md](./references/products/contact.md)                 |
| `devdoc`          | 开放平台文档：搜索开发文档                                        | [simple.md](./references/products/simple.md)                   |
| `ding`            | DING消息：发送/撤回（应用内/短信/电话）                              | [ding.md](./references/products/ding.md)                       |
| `report`          | 日志：按模版创建/收件箱/已发送/模版查看/详情/已读统计                         | [report.md](./references/products/report.md)                   |
| `todo`            | 待办：创建(含优先级/截止时间)/查询/修改/标记完成/删除                       | [todo.md](./references/products/todo.md)                       |
| `workbench`       | 工作台：应用管理                                             | [workbench.md](./references/products/workbench.md)             |

## 意图判断决策树

用户提到"表格/多维表/AI表格/记录/数据" → `aitable`
用户提到"审批/请假/报销/出差/加班" → `oa`
用户提到"考勤/打卡/排班" → `attendance`
用户提到"日程/日历/会议室/约会" → `calendar`
用户提到"群聊/建群/群成员/群管理/机器人发消息/Webhook/机器人群发/机器人单聊/通知" → `chat`
用户提到"通讯录/同事/部门/组织架构" → `contact`
用户提到"开发/API/调用错误 文档" → `devdoc`
用户提到"DING/紧急消息/电话提醒" → `ding`
用户提到"日志/日报/周报/日志统计/写日报/提交周报/发日志/填日志" → `report`
用户提到"待办/TODO/任务提醒" → `todo`
用户提到"工作台/应用管理" → `workbench`

关键区分: aitable(数据表格) vs todo(待办任务)
关键区分: report(钉钉日志/日报周报) vs todo(待办任务)
关键区分: chat send-by-bot(机器人身份发消息) vs send-by-webhook(自定义机器人Webhook告警)


> 更多易混淆场景见 [intent-guide.md](./references/intent-guide.md)

## 危险操作确认

以下操作为不可逆或高影响操作，执行前**必须先向用户展示操作摘要并获得明确同意**，同意后才加 `--yes` 执行。

| 产品 | 命令 | 说明 |
|------|------|------|
| `aitable` | `base delete` | 删除整个 AI 表格，含全部数据表和记录 |
| `aitable` | `record delete` | 删除记录（支持批量） |
| `calendar` | `event delete` | 删除日程，所有参与者同步取消 |
| `calendar` | `participant delete` | 移除日程参与者 |
| `calendar` | `room delete` | 取消会议室预定 |
| `chat` | `group members remove` | 移除群成员 |
| `todo` | `task delete` | 删除待办 |

### 确认流程
```
Step 1 → 展示操作摘要（操作类型 + 目标对象 + 影响范围）
Step 2 → 用户明确回复确认（如 "确认" / "好的"）
Step 3 → 加 --yes 执行命令
```

## 核心流程
作为一个智能助手，你的首要任务是**理解用户的真实、完整的意图**，而不是简单地执行命令。在选择 `dws` 的产品命令前，必须严格遵循以下四步流程：

1. 意图分类：首先，判断用户指令的核心 动词/动作 属于哪一类。这比关注名词更重要。
2. 歧义处理与信息追问：如果用户指令模糊或包含多个产品的关键字，严禁猜测。必须主动向用户追问以澄清意图。这是你作为智能助手而非命令执行器的核心价值。
3. 精准产品映射：在完成前两步，意图已经清晰后，参考产品总览和意图判断决策树 来选择产品。
4. 充分阅读产品参考文件，通过编写代码或直接调用指令实现用户意图。

## 错误处理
1. 遇到错误，加 `--verbose` 重试一次
2. 若 stderr 出现 `RECOVERY_EVENT_ID=<event_id>`，优先按 [recovery-guide.md](./references/recovery-guide.md) 执行 recovery 闭环
3. 仍然失败，报告完整错误信息给用户，禁止自行尝试替代方案
4. 认证失败时，参考 [global-reference.md](./references/global-reference.md) 中的认证章节处理
5. 各产品高频错误及排查流程见 [error-codes.md](./references/error-codes.md)


## 详细参考 (按需读取)

- [references/products/](./references/products/) — 各产品命令详细参考
- [references/intent-guide.md](./references/intent-guide.md) — 意图路由指南（易混淆场景对照）
- [references/global-reference.md](./references/global-reference.md) — 全局标志、认证、输出格式
- [references/field-rules.md](./references/field-rules.md) — AI表格字段类型规则
- [references/error-codes.md](./references/error-codes.md) — 错误码 + 调试流程
- [references/recovery-guide.md](./references/recovery-guide.md) — recovery 闭环、`RECOVERY_EVENT_ID`、`execute/finalize` 规范
- [scripts/](./scripts/) — 各产品批量操作脚本（AI表格/日历/机器人消息/通讯录/考勤/日志/待办等）
