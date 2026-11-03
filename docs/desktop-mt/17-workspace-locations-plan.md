# 默认工作空间、代码开发目录、消息平台与定时任务目录：实施计划

日期：2026-11-02。状态：已实现，定向测试通过，真机待验收。

代码核对基线：`release` 分支 `2c3a5b3912`。行号只作定位，以搜索符号为准。

## 给执行者

实施记录：

- 主进程初始化工作根时桌面日志缓冲区尚未创建，因此启动期使用 `console.warn`。迁移会先确认删除旧键后的 YAML 能序列化，再写偏好，以保留其它配置仍在引用的锚点。
- 现有 `before_turn` 对消息平台登记后会提前返回。目录路由钩子因此直接复用 `scratch_reminder`，向本轮消息提供实际的中间文件目录。定时任务仍使用单独的共享目录提醒。
- 按本篇范围分组验证。Electron 与页面测试共 87 项通过（同一用例的复测只计一次）；交付插件及请求中间件测试共 75 项通过、1 项跳过。Electron TypeScript 项目检查通过。完整桌面类型检查仍在聊天侧栏缺少 `emptyState`、邮件页面调用参数不足两处报错。
- 当前验证使用临时目录、受控请求和界面组件。真实账号跨盘切换、完整退出重启、网关收发、定时执行及打包版行为留给文末的真机验收。
- 真机验收后调整（覆盖下文相应内容）：设了默认位置不再加账号目录，所选文件夹本身就是工作根，已有的 `<默认位置>\<12 位>\` 留在原处不搬。保存和启动时各试建一次文件夹确认可写；保存时不可用就不保存并提示实际目录，启动时不可用就退回账号工作区并在设置页提示。目录联接解析成实际路径。插件建目录不再占用共用的锁。

- 按 P1～P5 顺序做，全部完成后合成**一个**本地提交，包括本文档。**不推送**，推送要等 Stan 明确同意。
- 产品代码预计 200～300 行（不含测试）。明显超出时先停下报告，不要自行扩大范围。
- 工作区里已有未提交文件（`apps/desktop/scripts/account-*.mjs`、`login-renderer.fixture.mjs`）与本任务无关，不要动、不要带进提交。
- **不修改 Hermes 核心**：`agent/`、`tools/`、`hermes_cli/`、`gateway/`、`tui_gateway/`、`cron/` 和根目录 Python 文件一行都不改。发现必须改核心时，停下报告。
- 新增函数都要有简洁中文注释。提交标题用 `类型(范围): 简洁中文说明`，正文按 `AGENTS.local.md` 的格式写，包括代码变化统计和未验证项。
- 只跑本文列出的相关测试，不跑全量。不操作 Stan 正在使用的桌面窗口，不发起付费模型调用。真机验收由 Stan 做。
- 不要把未执行的检查写成已通过。本文的判断来自读代码，**都没有实机验证**；代码和本文不符时，以代码为准，并在提交说明里写明差异。

## 目标

用户可以把工作文件放到任意盘，并且文件按用途分开：

| 用途 | 没设默认位置 | 设了默认位置 |
|---|---|---|
| 日常办公、学习 | `<账号>\workspace\YYYYMMDD-HHmmss\` | `<默认位置>\YYYYMMDD-HHmmss\` |
| 代码开发（没选项目） | `<账号>\workspace\UniWorkSpace\` | `<默认位置>\UniWorkSpace\` |
| 消息平台 | `<账号>\workspace\IM\` | `<默认位置>\IM\` |
| 定时任务 | `<账号>\workspace\cron\` | `<默认位置>\cron\` |

- `<账号>` 是现有的 `%LOCALAPPDATA%\uniworker\<12 位>`。设了默认位置时，**不加账号目录，也不加 `workspace` 层**。两个账号选同一个文件夹时，文件会混在一起。
- 下文把这一组四类目录的上一层叫“工作根”：没设时是 `<账号>\workspace`，设了是 `<默认位置>`。

## 已确定的规则

1. 默认位置改完**重启才生效**。启动时固定一次工作根，运行中不变。保存后弹提示。
2. 日常办公、学习每个对话一个日期文件夹；手选目录直接用，不新建。
3. 代码开发手选项目才进项目；没选一律进 `UniWorkSpace`，多个会话共用，不建日期文件夹。
4. **不做任何 Git 仓库判断。** 默认位置是仓库时，四类目录也建在仓库里，不处理。
5. 消息平台、定时任务**不做会话隔离**：所有平台和会话共用 `IM\`，所有任务和每次运行共用 `cron\`。
6. 手选过目录的定时任务继续用手选目录。
7. 专家和主助手走同一套规则。专家自己配置里已有 `terminal.cwd` 的行为不变（目前 28 个专家都没设）。

## 明确不做

- 消息平台、定时任务的会话隔离，不改网关进程目录（`desktop-environment.ts` 的 `TERMINAL_CWD` 不动）
- 沙箱、限制写到工作目录外
- 迁移旧文件和旧会话，补写旧会话的目录
- 路径长度检查；盘断开时的提示（目录不存在时设置页显示未设置，并使用账号工作区）
- 修改设置页的说明文字（`settingsHint` 虽已过时，也不改）
- 云盘目录（`ACCOUNT_DRIVE_MCP`、`ACCOUNT_DRIVE_ARTIFACT`）继续用 `ACCOUNT_RUNTIME.workspace`
- 新建工作空间入口、任务页打开文件夹按钮、临时任务分组

---

## P1：主进程工作根、旧值清理、对话文件夹

### 新增 `apps/desktop/electron/entry_local/work-root.ts`

放纯逻辑，便于测试。提供：

```ts
export const CODE_FOLDER = 'UniWorkSpace'
export const WORK_ROOT_FILE = 'desktop-work-root.json'

/** 算出某个默认位置对应的工作根；没设时用账号 workspace。 */
export function workRootFor(defaultDir: null | string, workspace: string): string

/** 启动时清理主助手配置里的 terminal.cwd，必要时转存到默认项目文件夹。 */
export function migrateTerminalCwd(home: string, defaultProjectFile: string, log: (m: string) => void): void

/** 启动时固定本次工作根：建目录、写给插件读的文件；失败退回账号 workspace。 */
export function prepareWorkRoot(options: {
  defaultDir: null | string
  workspace: string
  home: string
  blocked: (dir: string) => boolean
  log: (message: string) => void
}): string
```

**`usableWorkRoot`（替代最初的 `workRootFor`）：** 解析目录联接；命中 `blocked` 或试建文件夹失败时报错；成功返回实际路径。

**`prepareWorkRoot`：**
- 没设默认位置时用 `workspace`。
- 默认位置不可用时记日志，退回 `workspace`，并通过 `unusableDir` 告诉设置页。
- 向 `path.join(home, WORK_ROOT_FILE)` 写 `{"root": 生效工作根, "fallback": workspace}`。写失败只记日志，不阻止启动。

**`migrateTerminalCwd`（处理主助手的 `<home>\config.yaml`，不碰 `profiles\`）：**

| 情况 | 处理 |
|---|---|
| 文件不存在、解析出错或有警告 | 什么都不做 |
| `terminal` 不是独立映射（有锚点、合并键） | 什么都不做，记日志 |
| `terminal.cwd` 不存在、为空，或是 `.`、`auto`、`cwd` | 什么都不做 |
| `project-dir.json` 里 `dir` 为空，且该值（`~` 展开后）是已存在目录的绝对路径 | 写入 `project-dir.json`，再删 `terminal.cwd` |
| `project-dir.json` 已有 `dir` | 保留原值，只删 `terminal.cwd`，并把被丢弃的值写日志 |
| 其他无效值（相对路径、目录不存在） | 只删 `terminal.cwd`，写日志 |

写法沿用 `drive-mcp-config.ts`：`parseDocument(text, { version: '1.1', prettyErrors: false, logLevel: 'silent' })`，用 `doc.deleteIn(['terminal', 'cwd'])`，再 `writeSecretFileAtomic(file, String(doc), { encoding: 'utf8' })`。其他配置和注释必须保留。

### 修改 `apps/desktop/electron/main.ts`

1. 在 `ACCOUNT_DESKTOP_STATE`（约 669 行）之后、任何后端启动之前：
   ```ts
   migrateTerminalCwd(ACCOUNT_RUNTIME.home, ACCOUNT_DESKTOP_STATE.defaultProject, rememberLog)
   // desktop-mt: 启动时固定工作根，保存新默认位置后要重启才切换。
   const ACCOUNT_WORK_ROOT = prepareWorkRoot({ ... })
   ```
   `defaultDir` 用 `readDefaultProjectDir()`，`blocked` 用 `isPackagedInstallPath`。注意这两个函数依赖的常量（`IS_PACKAGED`、`APP_ROOT` 等）的定义顺序，必要时把这段往后挪，但必须早于所有后端启动。
2. `createConversationFolders(ACCOUNT_RUNTIME.workspace)`（约 821 行）改传 `ACCOUNT_WORK_ROOT`。
3. `resolveHermesCwd()`（约 4770 行）的候选改成 `[ACCOUNT_WORK_ROOT, ACCOUNT_RUNTIME.workspace]`，不再读 `readDefaultProjectDir()`。这样主后端和后来才启动的专家后端都用固定值（11880、12912 行的 `TERMINAL_CWD` 不用改）。
4. `hermes:setting:defaultProjectDir:get`（约 18018 行）多返回 `activeRoot: ACCOUNT_WORK_ROOT`。`dir` 仍是已保存的值，给设置页显示。
5. `hermes:setting:defaultProjectDir:set`（约 18027 行）：
   - 修复盘符根目录：现在 `mkdirSync('D:\\', { recursive: true })` 实测报 EPERM。改为目录已存在就不建。
   - 位置不可用时不保存，返回 `{ unusable: true, restartRequired: false }`。
   - 否则返回 `{ dir, activeRoot, restartRequired }`。`restartRequired` 是“新工作根与 `ACCOUNT_WORK_ROOT` 不同”，比较时 Windows 不区分大小写。
6. 更新 18014 行“no app restart needed”这条已不正确的注释。

**新增重启接口 `hermes:setting:defaultProjectDir:restart`。不要用现有的 `hermes:app:relaunch`，它绕过账号安全退出。**

```ts
let restartAfterQuit = false

// 校验来源：isDesktopRendererSender(event, ACCOUNT_SESSION, 渲染页地址)
ipcMain.handle('hermes:setting:defaultProjectDir:restart', event => {
  restartAfterQuit = true
  quitConfirmedWithActiveWork = true // 用户已在设置页的弹窗里确认过
  app.quit()
})
```

`createAccountLogout` 配置里的 `finish`（约 12266 行）改成：

```ts
if (mode === 'logout') {
  ACCOUNT_DRIVE_CLIENT.clearCredentials()
  await relaunchDesktop()
} else if (restartAfterQuit) {
  await relaunchDesktop() // 走完整退出，消息网关已停；不清登录凭据
} else {
  app.quit()
}
```

`before-quit` 里 `logoutDesktopAccount('quit')` 的 `catch`（约 19034 行）同时把 `restartAfterQuit` 复位。

### 修改 `apps/desktop/electron/entry_local/conversation-folder.ts`

- `ConversationFolders` 增加 `ensureCode(defaultCwd): Promise<null | string>`：
  - `defaultCwd` 不等于工作根，或工作根不是真实目录时，返回 `null`。
  - 否则建 `<工作根>\UniWorkSpace`（已存在则复用）和里面的 `.tmp`，返回路径。
  - `UniWorkSpace` 是链接或文件时返回 `null`（用 `lstat`）。
  - **不加入 `created`**，这样 `discard` 永远不会删它。
- 增加 IPC `hermes:conversation-folder:code`，校验方式和 `create` 相同。
- 把形参名和注释里的“账号工作区”改成“工作根”。

### 修改 preload 和类型

- `apps/desktop/electron/preload.ts`：增加 `ensureCodeFolder`、`settings.restartForDefaultProjectDir`。
- `apps/desktop/src/global.d.ts`：
  - `ensureCodeFolder?: (defaultCwd: string) => Promise<null | string>`
  - `getDefaultProjectDir` 返回值加 `activeRoot?: string`
  - `setDefaultProjectDir` 返回值加 `activeRoot?: string; restartRequired?: boolean`
  - `restartForDefaultProjectDir?: () => Promise<void>`

### 测试

新增 `electron/entry_local/work-root.test.ts`：
- 没设时工作根是 `workspace`；设了就是默认位置本身，不加账号目录和 `workspace` 层，也不留下检查用的文件夹。
- 目录联接解析成实际路径。
- 试建失败、命中 blocked 时退回 `workspace`，返回不可用的位置，插件文件内容正确。
- `migrateTerminalCwd` 覆盖上表每一行；验证其他配置和注释还在；验证 `profiles\` 不被改动。

修改 `electron/entry_local/conversation-folder.test.ts`：
- 现有用例把账号工作区换成工作根后仍通过。
- `ensureCode`：能建能复用；默认目录不符、是链接时返回 `null`；`discard(UniWorkSpace)` 不删除。
- 新 IPC 拒绝非桌面来源。

命令（在 `apps/desktop` 下）：
```
npx vitest run electron/entry_local/work-root.test.ts electron/entry_local/conversation-folder.test.ts
npm run typecheck
npx eslint electron/entry_local/work-root.ts electron/entry_local/conversation-folder.ts electron/main.ts electron/preload.ts
```

---

## P2：设置页

### `apps/desktop/src/app/settings/sessions-settings.tsx`（`DefaultProjectDirSetting`）

- 账号环境（`accountWorkspace` 为真）下，**不再调用** `applyConfiguredDefaultProjectDir`。
- `choose`、`clear` 保存后，如果 `result.restartRequired` 为真，打开确认弹窗；为假时不弹。
- 非账号环境保持原来的 toast 和行为。
- 弹窗用 `@/components/ui/confirm-dialog` 的 `ConfirmDialog`，不要 `destructive`：

| 字段 | zh |
|---|---|
| title | 默认工作空间已保存，重启后生效 |
| 正文 | 新位置：`{dir，清除时写“账号默认工作区”}`。重启前，新会话仍保存在：`{activeRoot}`。立即重启会停止当前账号正在运行的任务。 |
| confirmLabel | 立即重启 |
| cancelLabel | 稍后 |

`onConfirm` 调 `window.hermesDesktop.settings.restartForDefaultProjectDir()`。文案放进 `workdir-mt/copy.ts`（en、zh、zh-hant 都要有）。

### `apps/desktop/src/store/session.ts`

`syncConfiguredDefaultProjectDir` 中：

```ts
const { activeRoot, dir } = await settings()
// desktop-mt: 账号环境的默认位置只决定工作根，不能当成新对话的目录预填，否则代码开发会直接进默认位置。
configuredDefaultProjectDir = activeRoot ? '' : dir?.trim() || ''
```

结果：账号环境下 `workspaceCwdForNewSession()` 返回空串，没选目录的新对话不带目录。

### 隐藏第二个入口

- `apps/desktop/src/app/settings/config-subpages.ts`：`workspaceProjects` 的 `fields` 去掉 `terminal.cwd`，**保留** `prefixes: ['desktop.repo_scan_']`。
- `apps/desktop/src/app/settings/constants.ts`（约 711 行）：`workspace.keys` 去掉 `terminal.cwd`。
- 两处加 `// desktop-mt:` 注释说明原因。
- 不删 `working-directory-input.tsx`、`config-field.tsx` 的分支和语言文件，减少与上游的冲突。

### 测试

- `src/app/settings/sessions-settings.test.tsx`：`restartRequired` 为真时弹窗并显示新旧路径，点“立即重启”调用接口，点“稍后”不调用；为假时不弹；账号环境不调用 `applyConfiguredDefaultProjectDir`；非账号环境行为不变。
- `src/app/settings/subpages.test.ts`：工作目录项不再出现，仓库扫描项还在。
- `session.ts` 相关测试：有 `activeRoot` 时配置目录不发布；没有时和原来一样。

```
npx vitest run src/app/settings/sessions-settings.test.tsx src/app/settings/subpages.test.ts
npx eslint src/app/settings/sessions-settings.tsx src/app/settings/config-subpages.ts src/app/settings/constants.ts src/store/session.ts
```

---

## P3：聊天框工作目录按钮和代码开发默认目录

### `apps/desktop/src/app/chat/composer/index.tsx`（约 1586 行）

把 `<WorkdirPicker>` 挪到 `<ContribSlot area={COMPOSER_AREAS.leading} />` 之后。专家按钮由该插槽提供，这样按钮就在专家右边。

### `workdir-mt/conversation-folder.ts`

```ts
export const CODE_FOLDER = 'UniWorkSpace' // 与主进程 work-root.ts 一致

/** 代码开发默认目录的显示路径，分隔符跟随工作根。 */
export function codeFolderPath(root: string): string

/** 是否为系统自动用的目录（日期文件夹或 UniWorkSpace），“最近使用”不列；只按文件夹名判断。 */
export function isConversationFolder(path: string): boolean
```

`applyConversationFolder` 在取到 `defaultCwd` 之后改为：

```ts
if (!defaultCwd) return null

if ($codeWorkspace.get()) {
  // 带过来的项目目录照用；没有目录，或带过来的是工作根、UniWorkSpace，才进 UniWorkSpace。
  if (cwd && !sameWorkdir(cwd, defaultCwd) && !sameWorkdir(cwd, codeFolderPath(defaultCwd))) return null
  const folder = await window.hermesDesktop?.ensureCodeFolder?.(defaultCwd)
  if (folder) { params.cwd = folder; params.cwd_explicit = true }
  return folder ?? null
}

const folder = await create(defaultCwd)
// 后面不变
```

**为什么一定要带 `cwd`：** 后端只有收到非空 `cwd` 才把目录写进会话记录（`tui_gateway/session_workdir.py:_persisted_session_cwd`）。不带目录时，会话归到“无项目”，而代码开发项目栏不显示“无项目”（`sidebar/index.tsx:1279`）。今天已有 3 个会话因此看不到。

上面 `cwd && params.cwd_explicit === true` 就提前返回的判断保留。

### `workdir-mt/workdir-picker.tsx`

```ts
const codeDefault = defaultCwd ? codeFolderPath(defaultCwd) : ''
const picked = typeof target === 'string'
const isDefault =
  !shown || (!picked && (sameWorkdir(shown, defaultCwd) || (codeWorkspace && sameWorkdir(shown, codeDefault))))
```

- 发起会话后不显示：Hook 全部调用完后，`if (locked) return null`。删掉 Popover 分支，删掉只有它在用的 import 和 `lockedHint` 文案。
- “最近使用”：`recentWorkdirs(sessions, [defaultCwd, codeDefault], dir => isConversationFolder(dir))`。
- 手选目录等于默认位置时按手选显示（`picked` 为真就不算默认）。
- 显示的路径来自 `config.get project`，也就是生效的工作根。未重启时显示旧目录是预期行为。
- `chooseDefault` 不变。

### 文案（`workdir-mt/copy.ts`）

只在账号环境（`autoFolders` 为真）用新文案。非账号环境继续用原来的 `defaultName`、`folderHint`、`draftHint`。

| 位置 | 日常办公、学习 | 代码开发 |
|---|---|---|
| 默认项名称、按钮文字 | 每次新建文件夹 | 默认项目 |
| 默认项路径 | 新建在 `{工作根}` 下 | `{工作根}\UniWorkSpace` |
| 选默认项时的提示 | 本次对话的文件放在新建的文件夹里。开始对话后不能更改。 | 未选择项目的会话共用这个文件夹。开始对话后不能更改。 |
| 手选时的提示 | 直接在这个文件夹里工作，不新建文件夹。开始对话后不能更改。 | 直接在这个文件夹里工作。开始对话后不能更改。 |

en、zh、zh-hant 都要补齐。`settingsHint` 不改。

### 测试

- `workdir-mt/conversation-folder.test.ts`：
  - 代码开发：没带目录、带工作根、带 `UniWorkSpace` 都发出 `cwd=UniWorkSpace`、`cwd_explicit=true`；带项目目录时不变；手选直接返回。
  - 日常办公：行为不变。
  - `isConversationFolder` 只按名字判断，其他父目录下的日期文件夹也算。
- `workdir-mt/workdir-picker.test.tsx`：
  - 原“对话开始后只读显示”的用例（约 180～218 行）改为 `sessionId` 有值时不渲染。
  - 两种模式的文字。
  - 手选目录等于工作根时按手选显示。
  - 最近使用不列日期文件夹和 `UniWorkSpace`。
- `session/hooks/conversation-folder-create.test.tsx`、`detached-create.test.tsx`：按新行为调整。
- 如有输入框顺序相关测试，同步调整。

```
npx vitest run src/app/chat/composer/workdir-mt src/app/session/hooks/conversation-folder-create.test.tsx src/app/session/hooks/detached-create.test.tsx
npx eslint src/app/chat/composer/workdir-mt src/app/chat/composer/index.tsx
```

如果 `apps/desktop/scripts/workdir-picker.renderer.mjs` 夹具依赖锁定状态，一并调整。

---

## P4：插件把消息平台和定时任务指到各自文件夹

### 为什么不改进程目录

消息和定时任务通常在同一个网关进程里运行，一个进程只有一个 `TERMINAL_CWD`，分不开。网关还有 3 条启动路径（`entry_local/start-messaging-gateway.ts`、`plugins/desktop-messaging/dashboard/plugin_api.py`、`hermes_cli/web_server.py:933`）。按来源由插件指定，就不受这些影响。

### 新增 `plugins/desktop-deliverables/workfolders.py`

**目标目录：**

| `platform` | 文件夹 |
|---|---|
| `weixin`、`feishu`、`wecom`、`wecom_callback`、`dingtalk`、`uniagentgate`、`telegram`、`discord`、`whatsapp`、`whatsapp_cloud`、`slack`、`signal`、`mattermost`、`matrix`、`email`、`sms`、`bluebubbles`、`qqbot`、`yuanbao` | `IM` |
| `cron` | `cron` |
| 其他（`desktop`、`tui`、`cli`、`subagent`、`api_server`、`webhook` 等） | 不处理 |

名单用显式常量。不在名单里的平台保持原行为，不要猜。

**读取工作根：** `get_default_hermes_root() / "desktop-work-root.json"`。专家进程也能定位到账号 home（`hermes_constants.py:216`）。文件缺失或损坏时什么都不做，保持原行为。

**`route(*, platform="", task_id="", **_)`，注册为 `pre_llm_call`：**

1. 平台不在名单或没有 `task_id`：如果 `platform == "subagent"`，处理第 6 步；否则返回。
2. `task_id` 已分配过：确认目录还在（`mkdir(parents=True, exist_ok=True)`），不重复注册，否则会把 AI 这轮之前的 `cd` 打回去。定时任务继续走第 5 步的提醒。
3. 只处理本机终端：`_get_env_config().get("env_type") != "local"` 时返回（与 `__init__.py:local_cwd` 相同）。
4. 定时任务：`tools.terminal_tool.get_session_cwd(task_id)` 有值，说明用户手选过目录（`cron/scheduler.py:2303` 已记录），返回。手选目录失效时调度器不会记录，自然走到默认文件夹。
5. 依次尝试 `root/<文件夹>`、`fallback/<文件夹>`：建目录和里面的 `.tmp`，第一个成功的就用，并执行：
   ```python
   register_task_env_overrides(task_id, {"cwd": str(folder), "cwd_source": "session"})
   ```
   全部失败就记日志并返回，不影响回复。
   定时任务返回 `{"context": 提醒}`：
   > 本轮工作目录：{folder}。这个文件夹由所有定时任务共用。草稿、数据、脚本等中间文件放到 {folder}\.tmp（没有就新建）。成品放工作目录，文件名带上任务名和日期，避免盖掉之前的结果。
   消息平台不用加提醒，`before_turn` 的 `scratch_reminder` 通过 `workspace(task_id)` 会取到新目录。
6. 子代理：`get_session_cwd(task_id)` 等于某个已分配文件夹时，只记下 `task_id -> folder` 供第 7 步替换系统提示，不重新注册。子代理的目录由 `tools/delegate_tool_child_run.py:758` 从父任务继承。

**分配记录：** 模块级 `OrderedDict` 加锁，上限 512，超出时淘汰最旧的一条，并调用 `clear_task_env_overrides(被淘汰的 task_id)`。

**压缩换编号：** 消息会话的 `task_id` 就是 session_id，压缩后会变。下一轮按新 `task_id` 重新分配，目录相同，不用特殊处理。

**`rewrite_prompt(request, task_id)`，替换系统提示的目录行：**

系统提示在 `pre_llm_call` 之前生成（`agent/turn_context.py:1090` 与 `:1126`），钩子改不了，所以在发请求前改。

- 正则：`(?m)^Current working directory: .*$`（来源 `agent/prompt_builder.py:1010`）。
- 只有 `task_id` 有分配记录时才改。
- 处理这些位置，内容可能是字符串或 `[{"text": ...}]`：
  - `request["messages"]` 第一条 `system` 或 `developer` 消息
  - `request["instructions"]`
  - `request["system"]`
- **替换必须用函数形式**（`pattern.sub(lambda _: line, text)`）。Windows 路径的反斜杠放进替换字符串会被当成转义。
- 不修改传入对象，返回新字典；没有变化时返回 `None`。
- 数据库里存的系统提示不动。`agent/conversation_loop.py:878` 比较的是存下来的内容，不受影响。

### 修改 `plugins/desktop-deliverables/__init__.py`

- `register` 的钩子列表里，把 `("pre_llm_call", workfolders.route)` 放在 `before_turn` **之前**。`before_turn` 依赖新目录。
- `rewrite_llm_request` 里加第三步。Hermes 给每个请求中间件的都是原始请求，后一个的结果会盖掉前一个，所以必须合在这一个函数里依次做：
  ```python
  routed = workfolders.rewrite_prompt(request, context.get("task_id", ""))
  if routed is not None:
      request = routed
      reasons.append("workfolder")
  ```
  `task_id` 由 `agent/turn_api_request.py:144` 传入。
- 更新 `rewrite_llm_request` 的注释。`plugin.yaml` 的钩子列表已包含 `pre_llm_call`，不用改。

### 测试

新增 `tests/plugins/test_desktop_deliverables_workfolders.py`，加载方式参考 `test_desktop_deliverables_image_hints.py` 的 fixture：

- 微信、飞书都进 `IM\`；定时任务进 `cron\`，并带提醒；`desktop`、`tui` 不处理。
- 手选目录的定时任务不动，也没有提醒。
- 文件缺失或损坏时不处理；工作根建不成时用 `fallback`；都不成时不抛异常。
- 同一 `task_id` 第二轮不重复注册：先 `record_session_cwd` 模拟 `cd`，再跑一轮，记录不变。
- 新 `task_id`（模拟压缩换编号）进同一文件夹。
- `.tmp` 和 `workspace(task_id)` 都指向新目录，`scratch_reminder` 文字里是新路径。
- `rewrite_prompt`：`messages` 的字符串和列表两种内容、`instructions`、`system`；含反斜杠的 Windows 路径原样写入；无记录时返回 `None`；原对象不变。
- 子代理继承到已分配文件夹时替换提示，但不重新注册。
- 通过 `register` 验证 `route` 排在 `before_turn` 之前；通过 `rewrite_llm_request` 验证和看图提示、思考深度两步能叠加。

```
HERMES_PYTHON=<venv>/Scripts/python.exe bash scripts/run_tests.sh tests/plugins/test_desktop_deliverables_workfolders.py
HERMES_PYTHON=<venv>/Scripts/python.exe bash scripts/run_tests.sh tests/plugins/test_desktop_deliverables.py
HERMES_PYTHON=<venv>/Scripts/python.exe bash scripts/run_tests.sh tests/plugins/test_desktop_deliverables_image_hints.py
```

---

## P5：文档

- `13-conversation-folders-plan.md`：第 104 行改成新行为；第二步改为“见第 17 篇，消息平台 `IM\`，定时任务 `cron\`，都不隔离”。
- `07-chat-workdir.md`：更新按钮位置、发起会话后隐藏、文案和代码开发默认目录。
- 本文顶部状态改为“已实现，定向测试通过，真机待验收”，并写明实际差异。
- `README.md` 的文档列表更新本篇状态。

---

## 已知风险（已接受，不要顺手修）

| 风险 | 说明 |
|---|---|
| 同名文件被覆盖 | `IM\`、`cron\`、`UniWorkSpace\` 都是共用文件夹；定时任务只有文件名提醒，不能保证 |
| 互相能读到文件 | 消息平台的聊天之间能读到彼此的文件，AI 也可能拿错文件 |
| 工作目录外 | AI 用绝对路径或 `cd` 仍能写到外面 |
| 默认位置是仓库 | 账号目录建在仓库里，可能被提交 |
| 脚本任务 | 定时任务脚本不经过钩子，没设目录时在脚本所在目录运行；目前 5 个任务都没用脚本 |
| 外部运行模式 | Codex、Relay 这类模式走自己的目录逻辑（`agent/relay_cwd.py`），第一版不跟随 |
| 名单外的平台 | 走网关进程目录，也就是账号 `workspace` |
| 在桌面端继续消息会话 | 消息会话没有记录目录，落到桌面默认目录；能否继续发送也未实测 |
| 路径长度 | 默认位置很深时，`.tmp` 里装依赖可能超过 Windows 限制 |

## 真机验收（Stan 执行，不要代做）

| 项目 | 验证内容 |
|---|---|
| 默认位置 | 设到 D 盘：弹窗内容正确；点“稍后”后新对话仍在旧目录；重启后四类目录都到位 |
| 盘符根目录 | 可以选 `D:\`，四类目录直接建在 `D:\` 下 |
| 不可用的位置 | 选只读目录时提示实际目录、不弹重启；已保存的位置变成只读后重启，设置页显示同样的提示 |
| 立即重启 | 不掉登录；消息平台重启后恢复；开发版和打包版都走通 |
| 清理旧值 | 主账号的 `terminal.cwd = D:\桌面\test1` 被删除，`config.yaml` 其他内容不变，默认位置仍是 `D:\桌面\test1` |
| 专家 | 专家对话和主助手一样按日期建文件夹 |
| 按钮 | 在专家右边；发起会话后隐藏；文字和最近使用符合上表 |
| 代码开发 | 没选时进 `UniWorkSpace`，项目栏可见，重启后还在；手选项目后在项目里工作；项目、分支、worktree 不受影响 |
| 消息平台 | 微信、飞书的文件进 `IM\`；发文件回聊天正常；保存平台配置触发重启后目录仍正确 |
| 定时任务 | 网关开着和关着各跑一次，文件都进 `cron\`；手选目录的任务不受影响 |
| 系统提示 | 实际发出的请求里，目录行已替换；让 AI 用绝对路径写一个文件，确认落在对应文件夹 |
| 账号 | 没设默认位置时两个账号的文件分开；选同一默认位置时文件共用同一文件夹 |

Mac、U 盘、网络盘本次都未验证。
