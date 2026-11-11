# GitCode 普通内置 Skill

桌面原生 payload 在 `git archive` 后调用 `stage_bundled_skills()`，用配置仓库
`skills/public/` 的直接子目录重建暂存区 `skills/`。源码 `skills/uniwork/` 不参与
发布清单；保留内部 `autonomous-ai-agents/hermes-agent`。技能数量不写死。

默认来源为 `git@gitcode.com:uni-ai/uniclawwork-local-config.git`。桌面构建默认要求
来源成功；空清单、坏元信息、链接、特殊文件、跨平台文件名冲突、拉取失败都会终止构建。
配置过的来源失败时，即便 REQUIRED=0，也不会回退本地技能。

## 发布版本

构建参数仅作用于打包进程，不写入用户运行时配置：

```powershell
$env:UNIWORK_BUNDLED_PLUGINS_REF = '<配置仓库完整 commit SHA>'
$env:UNIWORK_BUNDLED_SKILLS_REF = $env:UNIWORK_BUNDLED_PLUGINS_REF
```

未指定技能 ref 时，同源专家/套件已记录的 commit 会成为技能拉取的固定 ref。
两份资源的 commit 不一致时构建失败。`UNIWORK_BUNDLED_SKILLS_SOURCE` 可显式指定
配置仓库 URL 或本地 Git checkout；正式构建对本地 checkout 同样获取已提交版本。
独立调用 native preparation 且未配置技能来源时仍不联网。

`skills/.bundled-source.json` 记录脱敏来源、ref、完整 commit、技能清单和每个资源文件
的 SHA-256。装配前后复核实际文件与清单，阻止后续 resource 覆盖混入本地技能。
Windows 安装包检查也校验解包后的实际资源。

## 源码应用预览

普通源码启动仍读取工作树中的技能。测试新发布清单时，先生成独立预览目录：

```powershell
python -m scripts.bundles.uniwork_bundled_skills --preview .build/gitcode-skills-preview --ref 461edc0db767e67261424fbec310863802ccbc3e
$env:HERMES_BUNDLED_SKILLS = Join-Path $PWD '.build/gitcode-skills-preview/skills'
.\dev-windows.ps1
```

输出目录必须尚不存在。当前开发交付已生成上述预览目录，可以直接执行后两行。
保持环境变量直到应用后台进程启动；旧后台进程需先正常退出。
若使用其他启动脚本，也应在同一终端设置该变量后启动。
结束预览后执行 `Remove-Item Env:HERMES_BUNDLED_SKILLS`。

预览与正式安装沿用现有 manifest 同步：未改动的退役项删除，修改过的退役项归档到
当前 profile 的 `skills/.retired-hermes/`，Hub 独立安装项和用户修改保留，用户删除过
的内置项不会重复复活。预览会实际执行这些升级操作，必要时使用独立开发 profile。

## 验证

使用项目规定的 `scripts/run_tests.sh`：

```bash
scripts/run_tests.sh tests/scripts/test_uniwork_bundled_skills.py tests/tools/test_skills_sync.py tests/scripts/test_uniwork_bundled.py tests/plugins/test_uniwork_kits_autoseed.py
```

新增测试通过真实临时 Git 仓库和真实同步/装配验证：固定提交、完整资源、18→4、
修改保护、Hub 保护、用户删除、A→B→A、重复同步、最终 payload、失败不回退、
Git 符号链接（包括 Windows 文本物化情况）。

本地还已从上述真实 GitCode commit 获取四项技能，在独立 HERMES_HOME 离线同步
得到四项普通技能加内部技能，第二次同步无新增。完整桌面安装包和 macOS/Linux
宿主构建仍需各自验收。现有 `test_bundle_native.py` 在当前 Windows 环境另有
长路径复制及符号链接权限失败，不能据此声称完整构建测试全绿。
