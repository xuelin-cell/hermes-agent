# macOS 桌面安装包构建

在仓库根目录执行 `./build-macos-installer.sh`。这是与根目录 Windows PowerShell 入口对应的 Bash 入口，复用 `scripts/bundles/desktop.py`，不复制后端组装和 Electron 打包逻辑。

## 前置条件

- 在 macOS 本机运行，安装 Xcode Command Line Tools（`xcode-select --install`）。
- 安装符合仓库 engines 的 Node.js/npm，并执行 `source ./activate` 准备 `.venv/bin/python`。
- 源码目录必须干净，包括未跟踪文件（Git 已忽略的构建输出除外）。需要保留在版本中的修改和新文件先提交，无关本地文件移到仓库外；入口在安装依赖前检查并列出阻塞文件。脚本构建当前 HEAD，不自动切换、拉取或推送分支。
- 首次准备会联网下载锁定依赖及发行内置资源，需能访问对应源。
- Python 后端和原生模块按本机目标构建。Apple Silicon 与 Intel 包分别在对应原生环境构建，不使用此入口生成 universal 包或跨架构包。

## 常用命令

```bash
# 查看帮助，不执行构建。
./build-macos-installer.sh --help

# 检查环境和源码状态，显示命令，不安装依赖或构建。
./build-macos-installer.sh --dry-run

# 默认生成未签名测试包。
./build-macos-installer.sh

# 按需设置本次代理和压缩级别。
./build-macos-installer.sh --proxy http://127.0.0.1:7890 --compression store

# 使用已有签名配置，签名身份缺失时构建失败。
./build-macos-installer.sh --signed
```

签名模式复用 Electron Builder 证书配置和现有公证钩子。公证可使用 `APPLE_NOTARY_PROFILE`，或完整的 `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`。凭据不写入脚本。`--signed` 要求代码签名，但并不强制配置公证；没有公证凭据时现有钩子会跳过公证，不能据此宣称已满足外部分发验收。

默认模式禁用证书自动发现并忽略签名和公证凭据，适合本机测试，不等同于已签名、公证的分发包。所有模式均禁用自动上传发布。

## 输出和复用

- 安装包：`apps/desktop/release/` 下的 DMG 和 ZIP，脚本打印本次生成的路径。
- 工作目录：`.build/desktop-job-macos`，由共享构建器管理。
- 依赖缓存：`.cache/desktop-inputs`，与已有入口一致；目标相关隔离由共享构建器负责。
- 临时目录：`.build/temp-macos/job.*`，本次结束时清理。

完整 bundled 包包含后端运行环境，并提前安装 Open Connector 依赖。版本、图标、内置资源及应用名称均沿用现有发行配置；当前名称为 **UniWork**，不是在此脚本中另建一套 Hermes 品牌身份。

脚本确认 DMG 和 ZIP 为本次生成，但这不代替安装验收。正式分发前仍需在目标架构机器验证安装启动、MaaS 登录、后端启动、内置工具、签名及公证状态。本次脚本开发不代表这些检查已完成。
