# 交付卡片与预览修复计划（六阶段改造后的问题）

本文档写给执行修复的编码代理。范围：`release` 分支上尚未推送的六个提交（`646708adff` 到 `be105d0100`，计划见 `10-deliverables-and-preview-plan.md`）在审查和实测中暴露的问题。

**一次改完，合并为一个本地提交，不推送。**

## 0. 动手前必读

1. 先读 `AGENTS.md`、`AGENTS.local.md`（本机未跟踪文件，规则同样有效）、`docs/desktop-mt/README.md` 的“协作规则”一节，全部遵守。重点：
   - 不改 Hermes 核心已有文件（`agent/`、`tools/`、`gateway/`、`hermes_cli/` 等）；
   - 每个新增函数或方法都要有简洁中文注释；
   - 提交标题和正文用中文，正文最后用一句话统计代码变化，格式见 `AGENTS.local.md`；
   - 不使用子 agent，不操作用户正在使用的桌面窗口。
2. 工作区里已有与本次无关的未提交改动：`apps/desktop/scripts/account-*.mjs`、`login-renderer.fixture.mjs` 等账户计时脚本。**不要修改、暂存或提交它们。** 提交时只 `git add` 本次改动的具体文件。
3. 本文档也随本次提交一起入库。

## 1. 问题与修法（共 9 项）

编号沿用审查清单。第 6、7、9、10、14、15 项已决定不修，见第 3 节。

### 插件：`plugins/desktop-deliverables/`

#### 第 1 项：同一文件在聊天里显示两次

**现象**：用户实测（小狗、关羽、小猫会话），同一张图片或视频出现两次。

**原因**：模型展示文件有三种写法，`transform()` 判断“已经展示过”时只认第一种。

| 写法 | 实例（来自真实会话） | 当前能否认出已展示 |
|---|---|---|
| 单独一行 `MEDIA:` | `MEDIA:C:\Users\stan\...\corgi_puppy.png` | 能 |
| Markdown 链接或图片，目标带 `MEDIA:` 前缀 | `![小狗](MEDIA:/C:/Users/stan/.../corgi_puppy.png)`，也见过 `![...](MEDIA:/C:\Users\...\puppy.png)` 这种斜杠混用 | 不能。`__init__.py:284` 的 `LINKS` 捕获到的是 `MEDIA:/C:/...`，`resolve_path` 解析不到同一路径 |
| 预览指令 | `::preview{file="C:/Users/stan/.../kitten.png"}`，属性值也可能用单引号 | 不能 |

**修法**：
- 在 `paths.py` 新增 `shown_paths(text, cwd)`，返回回复中已经以下列方式展示过的本机路径集合（每项都经 `resolve_path` 解析，丢弃 `None`）：
  - `LINKS` 捕获的链接目标，先去掉开头的 `MEDIA:` 和空白；
  - 不在独立行上的行内 `MEDIA:` 标记。语法与界面 `apps/desktop/src/lib/chat-messages/parts.ts` 的 `MEDIA_TAG_RE` 对齐：引号包裹的值，或以 `~/`、`/`、盘符开头、以 `EXTENSIONS` 中某个扩展名结束的路径；
  - `::preview{...}` 指令里的 `file="..."` 或 `file='...'`。
- `shown_paths` 要先把独立的 `MEDIA:` 行从文本中去掉再扫描。独立行由第 5 项的规则单独处理。
- `transform()` 用 `shown_paths` 替换现有的 `linked` 判断（`__init__.py:284-287`）。

#### 第 3 项：删掉 `MEDIA:` 行后原位置留下空行

**现象**：小狗 Word 会话中，模型写在正文中间的 `MEDIA:...docx` 被移到末尾，原位置留下 3～4 个连续换行。

**修法**：删除一行时连同它的换行一起删掉，不留空行。只处理被删行所在的位置，不对整段回复做全局空行压缩（避免改动代码块等内容）。

#### 第 5 项：模型写了的文件被删掉却没补回

**原因**：`__init__.py:270-287` 先按 `managed`（本轮全部候选文件）删除所有独立 `MEDIA:` 行，之后才：
- 在有文档时过滤掉图片；
- 截取前 8 个补回。

被过滤掉或排在第 9 个以后的文件，它们的行已经被删，就从回复里消失了。

**修法**：按下面的顺序重写这一段：
1. `shown = shown_paths(...)`（见第 1 项）。
2. 候选文件：保留现有规则（有文档时去掉图片，按 `priority` 排序），再去掉 `shown` 中已有的，取前 8 个，记为 `appended`。
3. 删除独立 `MEDIA:` 行，只删下面两种：
   - 路径属于 `appended`（稍后统一追加到末尾）；
   - 路径属于 `managed`，且同时已在 `shown` 里（模型对同一文件写了两种形式，保留非独立行那一处）。

   其余独立行一律保留在原位，包括被“有文档时去掉图片”过滤掉的图片行，以及第 9 个以后的文件行。
4. 末尾追加 `appended` 的 `MEDIA:` 行。

#### 第 4 项：Python 3.11 下整个插件失效

**原因**：`Path.is_junction()` 只在 Python 3.12 及以上提供，而仓库声明支持 `>=3.11`。当前有两处调用：
- `paths.py:154`
- `downloads.py:57`

**修法**：在 `paths.py` 新增一个 3.11 也能用的判断函数，两处都改为调用它。判断方法：
- 用 `os.lstat` 取文件信息；
- 符号链接（`stat.S_ISLNK`）算作链接；
- Windows 目录联接（`st_reparse_tag == stat.IO_REPARSE_TAG_MOUNT_POINT`，用 `getattr` 兼容非 Windows 平台）也算作链接；
- 路径不存在时返回 `False`，因为 `downloads.py` 的 `outputs` 目录可能尚未创建。

#### 第 8 项：任意工具失败就关闭本轮兜底扫描

**原因**：`__init__.py:217-219` 只要有任何工具结果不成功，就设置 `turn.guess = False`，于是本轮结束时不再对比目录。Hermes 里读文件、搜索失败很常见，这道兜底因此经常被关掉。

**修法**：只有可能写文件的工具失败时才设置 `guess = False`，即 `terminal`、`execute_code`、`write_file`、`patch` 这四个（可与 `before_tool` 的名单共用一个常量）。其他工具失败时只跳过对该结果的处理，不影响本轮结束时的扫描。

#### 第 11 项：重复扫描目录，扫描时持有全局锁

**原因**：
- `before_tool`（`__init__.py:165-193`）里，`watch_root` 首次观察某个目录时已经扫过一遍，紧接着 `snapshot(root)` 又扫同一目录；
- `after_tool` 再扫一遍；
- 三次扫描都在全局 `_lock` 内，同一后端中其他会话和账户的钩子都要等。

**修法**：
1. **复用**：`watch_root` 本次刚为该目录建立的基线，直接作为 `before`，不再扫第二遍。
2. **移出锁**：`os.walk` 放到锁外执行。流程为：
   - 锁内确定目录和状态；
   - 释放锁，在锁外扫描；
   - 重新加锁，确认 `current(session_id, turn_id)` 仍是同一轮，再写入结果。

   **必须保证不会把别的会话的文件算到本会话**。现有规则是：同一目录或互相包含的目录上存在重叠的执行窗口时，作废差异，见 `watch_root` 的 `ambiguous` 和 `before_tool` 中的 pending 作废逻辑。移出锁后，扫描期间别的会话可能开始或结束命令，需要为此补上判断。建议：
   - 维护一个全局递增序号，每次 `before_tool` 或 `after_tool` 登记、注销执行窗口时加一；
   - 扫描前记下序号，扫描后重新加锁比较；
   - 序号变化且变化涉及重叠目录时，按重叠处理，作废本次差异。
3. **退路**：如果无法在不引入错误归属的前提下把扫描移出锁，就只做第 1 步“复用”，保留锁内扫描，并在提交正文中写明原因。

### 界面：`apps/desktop/`

#### 第 2 项：`![说明](MEDIA:路径)` 显示后残留 `)`

**原因**：`src/lib/chat-messages/parts.ts` 的 `renderMediaTags()` 只把其中的 `MEDIA:路径` 替换成 `[文件名](#media:...)`，结果变成 `![小狗]([corgi_puppy.png](#media:...))`。Markdown 解析后多出一个 `)`。

**修法**：在 `renderMediaTags()` 现有两次替换之前，先把整个 `![任意说明](MEDIA:路径)` 或 `[任意说明](MEDIA:路径)` 替换为 `mediaLink(路径)`：
- 支持尖括号目标 `(<MEDIA:...>)`；
- 支持路径中有空格；
- 支持 `/C:/...` 和 `/C:\...` 两种斜杠写法；
- 说明文字丢弃。

替换后的显示效果必须与单独一行 `MEDIA:路径` 完全一致。图片、视频、音频都要覆盖。

#### 第 12 项：打开旧会话时，Word 和 PPT 卡片全部在后台排队转换

**原因**：`src/app/chat/right-rail/formats/prepare.ts` 对每张挂载的卡片都调用 `prepareOfficePreview`（主进程走 `electron/office-preview/ipc.ts` 中 `background` 分支的 `hermes:office-preview:convert`），历史会话里的卡片也不例外。

**参考**：UniWork（`source.new-uniclaw/libs/hexagent_demo/frontend/src/components/FilePreview.tsx` 的 `PptxPreview`）只在用户打开预览时才转换，转换结果存入磁盘缓存，没有提前转换。

**修法**：只对新文件提前转换。在主进程处理后台请求时判断：
- 磁盘缓存已命中：照旧直接返回；
- 缓存未命中，且源文件修改时间早于当前 10 分钟以上：直接跳过，不入队。

判断放在 `office-preview/service.ts` 的后台分支（该处已有 `source.stat`）或 `ipc.ts` 中，选改动更小的一处。用户点开预览走的是非后台请求，行为不变。

#### 第 13 项：去掉 PDF 卡片缩略图

**说明**：这是决定，不是缺陷修复。用户要求 PDF 卡片与 Word、PPT 等保持一致，只显示图标和文件名。

**修法**：
- 删除 `src/components/chat/pdf-thumbnail.tsx` 及 `pdf-thumbnail.test.tsx`；
- `src/components/chat/preview-attachment.tsx` 去掉导入（第 14 行）和 PDF 分支（第 134-135 行），所有类型统一使用现有图标；
- 同步修改 `preview-attachment.test.tsx` 中对 `./pdf-thumbnail` 的 mock 和相关断言；
- 只被缩略图使用的导出、样式或翻译键一并删除。删除前先全局搜索确认没有其他使用方；
- 修改 `docs/desktop-mt/10-deliverables-and-preview-plan.md`：B7 一行删去“PDF 附件首页缩略图”，第 195 行和第 198 行中关于缩略图的描述删除或注明已撤销。

## 2. 测试要求

每一项都必须有能证明修复生效的自动测试。先在修复前的代码上确认新测试失败，修复后通过，并在提交正文中如实记录。

| 项 | 测试位置 | 必须覆盖 |
|---|---|---|
| 1 | `tests/plugins/test_desktop_deliverables.py` | 三种写法各一例，每例中文件只出现一次。用真实会话的文本形态：`![小狗](MEDIA:/C:/...)`、`![...](MEDIA:/C:\...)`、`::preview{file="..."}`。非 Windows 平台上用测试目录的绝对路径构造对应形式 |
| 3 | 同上 | 正文中间的 `MEDIA:` 行被移走后，不出现连续三个以上换行；正文中原有的空行和代码块不变 |
| 5 | 同上 | ① 同时有图片和文档，模型为两者各写一行独立 `MEDIA:`，图片行保留；② 模型写 9 行独立 `MEDIA:`，最终 9 个文件都在回复中 |
| 4 | 同上或新文件 | 链接判断函数对普通目录、符号链接（无权限创建时跳过）、不存在的路径给出正确结果；在 Python 3.11 下运行插件全部测试 |
| 8 | `tests/plugins/test_desktop_deliverables_fallback.py` | `read_file` 失败后，本轮结束时的目录扫描仍能找到新文件；`terminal` 失败时仍关闭兜底 |
| 11 | `tests/plugins/` | ① 同一命令只扫描一次（可 monkeypatch `snapshot` 计数）；② 两个会话在同一目录先后执行命令，且扫描与另一会话的命令交错时，不会互相认领文件 |
| 2 | `src/lib/chat-messages/parts.test.ts` | `![说明](MEDIA:/C:/a/b.png)`、`[说明](MEDIA:C:\a\b.mp4)`、尖括号、带空格路径，渲染结果与独立 `MEDIA:` 行相同，且没有残留 `)` |
| 12 | `electron/office-preview/` 现有测试文件 | 后台请求：旧文件且无缓存时跳过；新文件照常入队；旧文件但已缓存时正常返回；非后台请求不受影响 |
| 13 | `preview-attachment.test.tsx` | PDF 卡片显示与其他类型相同的图标，不再读取 PDF 内容 |

## 3. 不在本次范围（不要改）

| 项 | 内容 | 不改的原因 |
|---|---|---|
| 6 | Markdown 中的网络图片下方也会出现文件卡片 | 用户决定暂不处理 |
| 7 | 大图文档导出 PDF 失败（data: 地址长度上限） | 用户决定暂不处理 |
| 9 | 从用户消息中识别目录时，把后面的文字一起取进来 | 用户决定暂不处理 |
| 10 | 所有目录共用一份扫描额度 | 用户决定暂不处理 |
| 14 | 代理 fake-IP（198.18.x）导致生成链接自动下载被拦截 | 保持现状，不改安全规则和账户配置 |
| 15 | 多个会话同时使用同一工作目录时，不补卡片 | 有意的保守设计，保持现状 |

## 4. 验证与提交

1. Python：
   - 用仓库 `.venv` 运行 `tests/plugins/` 下全部 `desktop_deliverables` 相关测试；
   - 再用 Python 3.11 运行同一组测试。本机已通过 uv 安装 3.11（`uv run --python 3.11 ...`）。
   - 如果 3.11 环境缺依赖、无法运行，在提交正文中写明，不要写成已通过。
2. 桌面端（`apps/desktop/`）：
   - 用 vitest 运行改动涉及的测试文件，以及 `src/lib/chat-messages/`、`src/components/chat/`、`src/components/assistant-ui/`、`src/app/chat/right-rail/`、`electron/office-preview/` 下的全部测试；
   - `npm run typecheck`；
   - 对改动文件运行 ESLint，要求零警告；
   - `git diff --check`。
3. 只提交一个 commit，标题建议：`fix(deliverables): 修复交付卡片重复并精简预览准备`。正文按 `AGENTS.local.md` 的要求分段写清：原来的问题、现在的处理、边界、实际验证结果、未验证的部分，最后一句统计代码变化。
4. **不要推送。**

## 5. 预计改动规模

| 类别 | 新增 | 删除 |
|---|---|---|
| 产品代码 | 约 110～120 行 | 约 155～160 行（其中缩略图组件约 115 行） |
| 测试 | 约 150～200 行 | 约 80 行（缩略图测试） |
| 文档 | 本文件，加上 `10-...md` 中的几行 | 几行 |

第 11 项最不确定。如果实际改动明显超出预计，在提交正文中说明原因。

## 6. 执行结果（2026-10-18）

九项范围内改动已实施；第 3 节的六项不在本轮处理范围，保持原行为。

- 已展示路径统一识别普通链接、带 `MEDIA:` 的链接、行内 `MEDIA:` 和单双引号预览指令。先选出实际追加的最多八项，再移走对应独立行；被过滤的图片和第九项以后原有标记保留。删除只吃掉该行及其换行，不压缩正文和代码块。
- 目录扫描全部移出全局锁。先登记观察根和执行窗口，再扫描、回锁核对当前轮次；执行窗口直到后快照完成才注销。重叠时直接作废窗口基线，根目录歧义保留至本轮结束，即使另一个会话已经结束也不恢复。这复用了已有状态，不再增加全局序号和事件缓存。首次命令新观察目录的一份快照同时作为根基线和命令前快照。
- 链接判断改用 `lstat`、符号链接模式位和 Windows reparse tag；下载目录继续拒绝联接。只有四个可能写文件的工具失败才关闭兜底。
- Markdown 包装整段替换为正式媒体链接，不再残留 `)`。后台 Office 请求先查磁盘缓存，未命中且修改时间早于十分钟前则跳过；主动点击不受限制。PDF 缩略图组件、测试、入口和专用尺寸参数已删除，原生夹具与阶段十文档同步更新。

验证与限制：

- 修复前，插件新增回归出现 15 项失败；界面包装、旧文件预转换及 PDF 挂载读取合计 8 项失败。修复后对应检查全部通过，没有降低断言。之后补测了轮次初始扫描期间的交错，四个阶段均不会阻塞另一会话或误认其产物。
- 仓库 `.venv` 缺少 pytest，未能直接用它运行测试。通过仓库 `.venv` 调用正式 `pm.build_env`，按当前锁文件和 dev／test／all 依赖在 `%TEMP%\hmt-deliverables-fix-8c5b1d2b\py314` 准备独立环境；使用 `scripts/run_tests.sh` 执行五个 `test_desktop_deliverables*.py`：Python 3.14.7 下 **57 项通过、1 项跳过**。跳过原因是当前 Windows 无法创建符号链接；真实目录联接、缺失目录和普通目录检查通过。覆盖真实插件发现、原版工具、HTTP 下载、数据库关闭重开及账号边界，不调用真实模型。
- Python 3.11.15 全组测试**未通过验收**：正式 PM 构建被锁文件的 `python_full_version >= '3.14'` 支持环境限制拒绝，未改锁文件或补造结果。独立 3.11 标准库探针已实际加载路径模块，验证普通／缺失目录、含子目录的扫描和 MEDIA 路径识别；不能据此声称整组 3.11 测试通过。
- 桌面定向三文件 **29 项通过**。按计划运行五个目录的全部匹配测试：**155 个文件，1,279 项通过、1 项失败**。唯一失败是 `src/components/assistant-ui/thread/streaming.test.tsx` 期待 `UniWork is loading a response`，实际为 `Hermes is loading a response`。单独复测并在独立转换中加载 `be105d0100` 的相关基线源码后，仍得到同一文案失败；未修改该范围外测试或产品文案，全量回归不记为全绿。
- 完整 `npm run typecheck`、改动文件 ESLint 零警告、Prettier、Python Ruff 和 `git diff --check` 通过。
- `node scripts/preview-tools.native.mjs --run`：独立 Electron 夹具 **1 项通过**，实际验证普通 PDF 卡片、剪贴板、三种另存为、SVG 切换和受控账号组件；截图已检查，记录在 `%TEMP%\hermes-preview-tools-4tREjS`。本轮未启用 `--office`，没有调用用户 Office、真实 MaaS、短信或付费模型，也没有操作现用窗口。
- 产品和测试比最初行数预估略多，主要来自四个扫描阶段的真实线程交错及失效复核；没有新增依赖、迁移或核心改动。用户实际会话的生成与重开仍待人工复核。

只创建一个本地修复提交，不推送；不改动或收录无关账号计时脚本。
