# 全局参考

## 安装

### 本地安装 (无需网络)

dws 使用本地打包的二进制文件安装，无需网络下载。

**安装脚本**: `<skill-dir>/scripts/install.sh`

```bash
# 自动检测架构并安装
sh <skill-dir>/scripts/install.sh

# 强制指定架构
sh <skill-dir>/scripts/install.sh --arch amd64  # x86_64
sh <skill-dir>/scripts/install.sh --arch arm64  # aarch64

# 查看帮助
sh <skill-dir>/scripts/install.sh --help
```

**支持的架构**:

| 架构 | 文件 | 适用系统 |
|------|------|----------|
| `amd64` | `dws-linux-amd64.tar.gz` | x86_64 Linux |
| `arm64` | `dws-linux-arm64.tar.gz` | ARM64 Linux |

**环境变量**:

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DWS_INSTALL_DIR` | 安装目录 | `~/.local/bin` |

**安装后配置**:

```bash
# 如果安装目录不在 PATH 中，添加到 PATH
export PATH="$HOME/.local/bin:$PATH"

# 永久添加到 shell 配置
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

# 验证安装
dws version
```

### 安装问题排查

| 问题 | 解决方案 |
|------|----------|
| `Archive not found` | 检查 `scripts/dws-linux-*.tar.gz` 是否存在 |
| `Unsupported architecture` | 使用 `--arch` 参数指定 amd64 或 arm64 |
| `Permission denied` | 检查对 `~/.local/bin` 的写入权限 |
| `command not found` | 确认 PATH 包含安装目录 |

## 认证

> ⚠️ **重要**: Linux 服务器/虚机环境鉴权必须使用 `auth.sh` 脚本，禁止直接执行 `dws auth login` 命令。

### 基础认证命令（仅供参考）

```bash
# 查看状态
dws auth status

# 退出
dws auth logout

# 重置本地凭证 (Token 解密失败时使用)
dws auth reset
```

登录后自动管理 token 刷新，日常使用无需重复登录。

| Token | 有效期 | 说明 |
|-------|--------|------|
| Access Token | 2 小时 | 调用 API 的凭证，过期自动刷新 |
| Refresh Token | 30 天 | 换新 Access Token，使用后轮转 |

30 天内使用一次即自动续期。

### 认证失败处理
- 命令返回 `AUTH_TOKEN_EXPIRED` / `USER_TOKEN_ILLEGAL` / "Token验证失败" → 使用 `auth.sh` 脚本重新登录

### Linux 服务器/虚机环境 (Headless) 认证流程

**适用场景**: 无浏览器的 Linux 服务器、Docker 容器、远程虚机等环境

> ⚠️ **禁止直接使用 `dws auth login --device`**，必须使用 auth.sh 脚本进行鉴权。

#### 使用 auth.sh 脚本（必须）

脚本位于 `<skill-dir>/scripts/auth.sh`，封装了完整的设备流登录流程。

```bash
# 检查认证状态
sh <skill-dir>/scripts/auth.sh --check

# 启动设备流登录
sh <skill-dir>/scripts/auth.sh
```

脚本会自动：
1. 检查 dws 是否已安装
2. 检查当前认证状态（已认证则跳过）
3. 启动后台设备流登录进程
4. 输出授权链接供用户扫码

**auth.sh 脚本用法**:

| 命令 | 说明 |
|------|------|
| `sh auth.sh` | 启动设备流鉴权登录 |
| `sh auth.sh --check` | 仅检查鉴权状态，不执行登录 |
| `sh auth.sh --help` | 显示帮助信息 |

**环境变量配置**:

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DWS_AUTH_LOG_DIR` | 鉴权日志目录 | `/sessions/$USER` |
| `DWS_AUTH_TIMEOUT` | 等待授权链接超时秒数 | 30 |

**鉴权操作流程（必须严格遵守）**:

1. **执行 auth.sh 脚本**
   ```bash
   sh <skill-dir>/scripts/auth.sh
   ```

2. **等待脚本输出授权链接**

3. **将授权链接展示给用户**
   - 告知用户在浏览器中打开链接并完成钉钉扫码授权

4. **等待用户确认授权完成**

5. **验证鉴权状态**
   ```bash
   sh <skill-dir>/scripts/auth.sh --check
   ```
   - 显示 `AUTHENTICATED` → 成功
   - 显示 `NOT AUTHENTICATED` → 重复上述步骤

#### 环境变量认证 (CI/CD)

```bash
# 设置钉钉应用的 Client ID 和 Secret
export DWS_CLIENT_ID=<your-app-key>
export DWS_CLIENT_SECRET=<your-app-secret>

# 执行登录
dws auth login
```

**注意**: refresh_token 单设备独占，远程刷新后源设备凭证失效。

#### 验证认证状态

```bash
# JSON 格式输出，便于脚本解析
dws auth status --format json

# 示例输出:
# {"status": "authenticated", "user_id": "xxx", "expires_at": "..."}
# 或
# {"status": "unauthenticated", "error": "token expired"}
```

#### 常见问题排查

| 问题 | 解决方案 |
|------|----------|
| `command not found: dws` | 未安装或不在 PATH，执行 `sh install.sh` 后检查 PATH |
| `Archive not found` | 检查 `scripts/dws-linux-*.tar.gz` 文件是否存在 |
| `Unsupported architecture` | 使用 `--arch amd64` 或 `--arch arm64` 指定架构 |
| `device flow timeout` | 用户未在规定时间内完成授权，重试 |
| `token decrypt failed` | 执行 `dws auth reset` 后重新登录 |
| 日志文件不存在 | 检查 `$DWS_AUTH_LOG_DIR` 目录权限 |
| auth.sh 权限问题 | 执行 `chmod +x auth.sh` 或用 `sh auth.sh` |

## Recovery

当 runtime/MCP 命令失败且 stderr 额外输出 `RECOVERY_EVENT_ID=<event_id>` 时，说明 CLI 已经持久化了失败快照，可进入 recovery 闭环：

```bash
dws recovery plan --event-id <event_id> --format json
dws recovery execute --event-id <event_id> --format json
dws recovery finalize --event-id <event_id> --outcome recovered|failed|handoff --execution-file execution.json --format json
```

- `plan` / `execute` 也支持 `--last`，但 `--last` 与 `--event-id` 互斥
- recovery 文件保存在 `DWS_CONFIG_DIR/recovery/`
- CLI 会自动清理 30 天前的 recovery 文件和事件记录
- recovery 自己发起的文档检索与只读 probe 不会再创建新的 recovery 事件

更多闭环要求见 [recovery-guide.md](./recovery-guide.md)。


## 全局标志

| 标志 | 短名 | 说明 | 默认 |
|------|:---:|------|------|
| `--format` | `-f` | 输出格式: json / table / raw | json |
| `--jq` | | jq 表达式过滤输出 (如: `.items[] \| .name`) | 无 |
| `--fields` | | 筛选输出字段 (逗号分隔, 如: name,id,status) | 无 |
| `--verbose` | `-v` | 详细日志 | false |
| `--debug` | | 调试日志 | false |
| `--yes` | `-y` | 跳过确认提示 | false |
| `--dry-run` | | 预览操作不执行 | false |
| `--timeout` | | HTTP 超时 (秒) | 30 |
| `--mock` | | Mock 数据 (开发用) | false |
| `--client-id` | | 覆盖 OAuth Client ID | 无 |
| `--client-secret` | | 覆盖 OAuth Client Secret | 无 |

## 输出格式

### --format json (机器可读, 默认)

```json
{"success": true, "body": {...}}
```

### --format table (人类可读)

```
已创建 AI 表格 "项目管理" (UUID: abc123)

下一步:
  dws aitable base get --base-id abc123
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `DWS_CONFIG_DIR` | 覆盖默认配置目录 |
| `DWS_SERVERS_URL` | 自定义服务发现端点 |
| `DWS_CLIENT_ID` | 覆盖 OAuth Client ID (DingTalk AppKey) |
| `DWS_CLIENT_SECRET` | 覆盖 OAuth Client Secret (DingTalk AppSecret) |

凭证优先级: `--token` > `DWS_CLIENT_ID`/`DWS_CLIENT_SECRET` > OAuth 加密存储 (.data)
