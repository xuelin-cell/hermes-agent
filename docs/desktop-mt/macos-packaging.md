# macOS 桌面安装包构建

在仓库根目录执行 `./build-macos-installer.sh`。这是与根目录 Windows PowerShell 入口对应的 Bash 入口，复用 `scripts/bundles/desktop.py`，不复制后端组装和 Electron 打包逻辑。

## 前置条件

- 在 macOS 本机运行，安装 Xcode Command Line Tools（`xcode-select --install`）。
- 安装符合仓库 engines 的 Node.js/npm，并执行 `source ./activate` 准备 `.venv/bin/python`。
- 源码目录必须干净，包括未跟踪文件（Git 已忽略的构建输出除外）。需要保留在版本中的修改和新文件先提交，无关本地文件移到仓库外；入口在安装依赖前检查并列出阻塞文件。脚本构建当前 HEAD，不自动切换、拉取或推送分支。
- 首次准备会联网下载锁定依赖及发行内置资源，需能访问对应源。
- Python 后端和原生模块按本机目标构建。Apple Silicon 与 Intel 包分别在对应原生环境构建，此原生入口不跨架构构建；单个 Universal DMG 使用下文的独立合并入口。

## 常用命令

```bash
# 查看帮助，不执行构建。
./build-macos-installer.sh --help

# 检查环境和源码状态，显示命令，不安装依赖或构建。
./build-macos-installer.sh --dry-run

# 默认生成临时签名内部测试包。
./build-macos-installer.sh

# 按需设置本次代理和压缩级别。
./build-macos-installer.sh --proxy http://127.0.0.1:7890 --compression store

# 使用已有签名配置，签名身份缺失时构建失败。
./build-macos-installer.sh --signed
```

签名模式复用 Electron Builder 证书配置和现有公证钩子。公证可使用 `APPLE_NOTARY_PROFILE`，或完整的 `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`。凭据不写入脚本。`--signed` 要求代码签名，但并不强制配置公证；没有公证凭据时现有钩子会跳过公证，不能据此宣称已满足外部分发验收。

默认模式禁用证书自动发现并忽略签名和公证凭据，使用 ad-hoc 身份签署应用和内置原生组件。签名后更新运行时摘要、重新封存应用，并通过 `codesign --verify --deep --strict`，失败即停止构建。此模式无需 Apple 开发者账号，但不具有开发者身份和公证信任，不能保证 Gatekeeper 自动放行。所有模式均禁用自动上传发布。

内部测试接收方应删除旧应用后安装新包。首次打开若被阻止，可在系统设置 → 隐私与安全性中查看是否提供“仍要打开”，仅对已核实来源的测试应用操作；若没有该选项或仍提示损坏，应收集签名校验结果继续排查，不关闭系统安全检查。临时签名不解决 Intel 与 ARM 架构不匹配，也不代表已在接收方机器验收。

## 输出和复用

- 安装包：`apps/desktop/release/` 下的 DMG 和 ZIP，脚本打印本次生成的路径。
- 工作目录：`.build/desktop-job-macos`，由共享构建器管理。
- 依赖缓存：`.cache/desktop-inputs`，与已有入口一致；目标相关隔离由共享构建器负责。
- 临时目录：`.build/temp-macos/job.*`，本次结束时清理。

完整 bundled 包包含后端运行环境，并提前安装 Open Connector 依赖。版本、图标、内置资源及应用名称均沿用现有发行配置；当前名称为 **UniWork**，不是在此脚本中另建一套 Hermes 品牌身份。

脚本确认 DMG 和 ZIP 为本次生成，但这不代替安装验收。正式分发前仍需在目标架构机器验证安装启动、MaaS 登录、后端启动、内置工具、签名及公证状态。本次脚本开发不代表这些检查已完成。

## 单个 Universal DMG（Intel 与 Apple Silicon）

新增 `build-macos-universal.sh`，用于将同一提交生成的两份原生 `.app` 合并为一个内部测试 DMG。它不在 ARM 主机上伪造 Intel Python 环境，也不要求接收方选择架构。

1. 在 Intel Mac/原生 x64 构建环境和 Apple Silicon 构建环境分别检出同一提交，运行 `./build-macos-installer.sh`。
2. 收集 `release/mac/UniWork.app`（实际以 x64 构建输出为准）和 `release/mac-arm64/UniWork.app`。跨机器传输使用原构建 ZIP 或保留符号链接的归档，不手工拆散 `.app`。
3. 在已安装仓库锁定 Node 依赖和 `.venv` 的 Mac 执行：

```bash
./build-macos-universal.sh \
  --x64-app /路径/Intel/UniWork.app \
  --arm64-app /路径/AppleSilicon/UniWork.app \
  --out "$PWD/apps/desktop/release/universal-test-1"
```

输出目录必须不存在，避免覆盖旧包或构建输入。成功时打印 `UniWorkBundled-<版本>-mac-universal.dmg`。两份输入必须包含新版运行布局标记、相同提交和产品版本，并使用外部更新模式；旧版本 `.app` 会被拒绝。必须先重建两种架构，不能拿之前的旧 arm64 包直接合并。

合并保留两套 ASAR、Python/工具载荷和 OpenConnector，Electron 原生外壳合并为 Universal。入口按当前执行架构选择同一套资源，支持 ESM 主进程和解包后的原生模块路径。这样优先保证兼容性，尚未对重复前端资源做体积优化。

合并后统一临时签名、重算两套载荷摘要并验证整个应用，再生成带 Applications 快捷方式的 DMG。不发布、不生成正式更新通道；此入口暂不提供 Developer ID 公证模式。签名失败或输入不匹配时不会报告打包成功。

已用本机编译的两种 Mach-O 测试应用验证合并、签名、严格验证和真实 Electron ESM 启动；这不是完整 UniWork 双架构验收。仍需同一提交的 Intel 完整构建输入，在两种 Mac 上验证安装、真实后端、登录恢复、云盘和连接器。
