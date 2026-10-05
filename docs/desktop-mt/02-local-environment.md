# entry_local 与账号环境

实现位置：`apps/desktop/electron/entry_local/`。本模块只管理账号环境，模型推理、会话和工具行为由原版 Hermes 执行。

## P11 · 稳定账号目录

`account-paths.ts` 使用 UTF-8 的 `JSON.stringify([平台身份域, UID])` 计算完整 SHA-256，形成 `account-<64 位摘要>`。token、手机号、Key 和期限不参与标识；同账号重新登录定位原目录。

默认目录：

```text
%LOCALAPPDATA%\hermes-desktop-mt\accounts\account-<摘要>\
  hermes-home\
  workspace\

%APPDATA%\HermesDesktopMT\accounts\account-<摘要>\desktop-state\
```

UID 原文不成为路径组件。主进程只接受有效 `LoginSession` 的身份和绝对受管根；逐层拒绝符号链接、Windows junction 或文件占位，重复初始化保留内容。失败不回退其它 Home、不删除数据。

## P12 · MaaS 模型配置

`model-config.ts` 使用现有 `yaml` 的 YAML 1.1 文档节点更新账号 `config.yaml`。

- 按端点分组，提供方标识为 `desktop-mt-maas-<端点完整摘要>`。
- 只维护标识、端点和 `key_env: DESKTOP_MT_MAAS_API_KEY` 均匹配的托管记录；归属或凭据覆盖冲突时拒绝写入。
- 成功套餐更新托管模型目录，删除退出套餐的托管端点和模型，保留仍有效模型的选项、个人提供方及其它设置。
- 仅当配置文件不存在时设置套餐主模型为初始默认。已有默认选择不改；所选模型退出套餐后需用户自行重新选择。
- 损坏 YAML、重复键、无效引用、目标共享结构、链接或写入失败停止准备，保留原文件。无变化不写入。

## P13 · 专用模型 Key

`model-key.ts` 只维护账号 `hermes-home/.env` 中的 `DESKTOP_MT_MAAS_API_KEY`，保留个人变量、注释、BOM、换行和多行值。Windows 下移除该专用变量的大小写副本，末尾保留唯一赋值。

| 套餐结果 | 配置与 Key |
| --- | --- |
| `available` | 先合并模型配置，再写专用 Key |
| `empty` | 专用 Key 写为空值，模型目录及个人 Key 保留 |
| `failed` | 配置与 Key 文件均不改，不把旧缓存当作刷新成功 |

两个文件分别原子替换，不是跨文件事务。第二步失败时可能已有新模型目录，但账号环境不放行；修复后完整退出重开。Key 拒绝控制字符、非 ASCII 和变量展开引用，凭据文件须为 UTF-8 普通文件。

模型 Key 按原版机制明文存入账号 `.env`；MaaS 登录 token 使用独立系统加密记录，不写进 `.env`。Windows 目录使用继承的 ACL，不宣称整个账号目录已加密或具有操作系统级隔离。

## P14 · 固定账号上下文

`LocalRuntimeContext` 由登录壳持有，只从主进程身份选择账号。配置准备成功后发布冻结的账号标识、Home、默认工作区、桌面状态目录、开发仓库和解释器路径；同一进程不能换成另一账号。

源码与 Python 共享，不为每个账号复制安装。复用 `resolveSourcePython()` 选择开发运行时，缺失时停止准备，不寻找官方安装、不自动安装依赖。

已经准备的固定上下文和脱敏账号信息在运行中到期后保留，供继续工作和手动退出使用；它们不作为新的登录身份。真正退出时释放主进程身份。

## P15 · 启动原版本地 Hermes

`desktop-runtime.ts` 先写账号运行记录，再通过 `desktop-environment.ts` 绑定环境，之后才加载原版 `main.ts`。

环境固定当前账号 `HERMES_HOME`、默认 `TERMINAL_CWD`、开发源码和 Python，清除继承的旧 Home dotenv、专用 Key、活动 Profile 和远程连接提示。普通系统环境与本机工具配置保留。

后端使用原版 `hermes serve --isolated`、回环地址 `127.0.0.1`、系统分配端口和随机本地凭据；桌面复用 REST／WebSocket。首次主窗文档就绪后交接并关闭登录窗。开发版 URL scheme 为 `hermes-desktop-mt`。

账号自定义 `desktop.electron_flags` 和 `renderer_max_old_space_mb` 尚未接入启动前配置。

## P16 · 主进程账号状态

`desktop-state.ts` 定位账号连接、活动 Profile、默认项目、后端归属／就绪、原生 OAuth 凭据、远程凭据加密策略、SSH 更新恢复、图标、粘贴图片和外部终端脚本。插件提示已读记录同样按账号保存，具体读写仍复用原版函数。

应用级 `userData`、公共登录密文、应用锁、安装与更新状态、GPU／沙箱标记保持固定。窗口几何、设备外观、缩放、快捷键、托盘和资源偏好保留应用级位置。旧全局账号文件不自动认领、不作为缺失回退。

## P17 · 浏览器分区与界面状态

`browser-partition.ts` 对 `JSON.stringify([账号标识, 用途])` 计算完整摘要，形成 `hermes-mt-<摘要>`，保留原用途的 `persist:` 属性。

账号主窗、副窗、会话窗、浏览器宿主及辅助窗使用账号 Session；媒体、下载、权限和请求头处理也绑定该 Session。预览 webview、嵌入内容和远程 OAuth 按用途分别隔离，预览保留原版安全规则。

Cookie、localStorage、IndexedDB、草稿和界面状态由 Electron 分区与原版 Renderer 存储机制管理。持久分区位于应用 `userData/Partitions`；不手工复制浏览器数据库、不改变全局 `userData`。同账号重开复用分区，不通过清空草稿实现隔离。

## 数据边界

账号 Home、默认工作区、主进程文件和浏览器存储分别隔离。主动选择相同外部项目会共享文件；同一 Windows 用户运行的工具仍可能访问其它账号目录。

不自动导入旧无账号数据，不修改官方对照版。退出和恢复规则见[生命周期](03-lifecycle-and-acceptance.md)，默认路径与人工操作见[使用说明](USAGE.md)。
