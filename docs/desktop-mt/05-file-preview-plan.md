# 文件预览改造实施计划

日期：2026-10-13。基线：`desktop-mt @ d5ff498050`（代码事实核对于同步远端 `40caef7b87` 之前，P01 动手前需复核）。参考实现：UniWork 桌面版 `Kyle549/UniClaw @ uniwork_release`（`8ae3548e`）、Web 版 `feat/hermes-ch`（`3bef1c5bd4`）。

状态：P01 已实现并完成自动验证，等待用户核验；P02～P16 未开始。本文不授权推送。每步完成验证并本地提交后暂停，等待用户核验，再继续下一步。

路径约定：`src/`、`electron/` 指 `apps/desktop/` 下的对应目录；`shared/` 指 `apps/shared/src/`。各步骤的行数是预估的业务代码行数，不含测试、夹具和文档；多语言文案单独列出。

## 1. 本轮目标与边界

一句话：在桌面端前端建一个“预览中心”，所有文件预览都经过它；Office 文件由桌面程序调用本机的 MS Office、WPS 或 LibreOffice 转成 PDF 再显示；Hermes 后端一行不改。

本轮完成四件事：

1. 建立预览中心：一张表认类型，一张表选显示方式，一个地方负责拿文件内容。以后加格式只登记，不改旧代码。
2. 新增 UniWork 桌面版已支持、当前分支还不支持的格式：音频、视频、CSV／TSV、TIFF、Word、PPT、Excel。
3. 在 Electron 主进程实现本机 Office 转 PDF，带缓存、排队、超时和明确的失败原因。
4. 给云端留好位置：区分“本机还是远程”的代码只放在一个文件里，失败原因代码与 Web 版一致。本轮不写云端实现。

必须保留：

- 现有文本、代码、Markdown、图片、PDF、HTML 预览的行为。`preview-file.tsx` 不搬、不改。
- 文本预览的编辑、差异对比、行引用拖拽；HTML 的渲染／源码切换和内置浏览器。
- 官方远程连接下已有的预览能力，不因本轮改造退化。
- 账号隔离：转换缓存放在当前账号目录下，不跨账号共用。
- 用户未提交的本机计时脚本、官方对照版和用户数据。

本轮不包含：

- 修改 Hermes Python 后端（`hermes_cli/`、`tools/`、agent 核心）：不改现有文件，也不新增文件。
- 本地虚拟机或容器。
- 云端 Hermes 的接入，以及云端文件预览的实现。
- 个人云盘里的文件接入预览中心（仍按现状用内置浏览器打开签名链接）。
- 文件一生成就预先转换、超大文件的流式读取（见第 12 节）。
- 把 LibreOffice 打进安装包。
- macOS、Linux 上的实测。

## 2. 已确认的决定

| 事项 | 决定 |
| --- | --- |
| 操作系统 | 本轮只保证 Windows。macOS、Linux 上代码可运行，但只走 LibreOffice，不做实测 |
| 后端 | 不修改 |
| 前端上游文件 | 允许少量改动：每处只加一个入口或几行登记，提交正文列出实际改动的上游文件 |
| 转换软件与顺序 | MS Office → WPS → LibreOffice；前一个不可用或失败就用下一个 |
| LibreOffice | 不打包；三种软件都没有时提示用户自行安装 |
| 后台启动 Office | 接受。转换时会在后台用到用户的 MS Office 或 WPS，失败按降级规则处理 |
| 表格解析库 | SheetJS 官方渠道的最新版，不用 npm 仓库里停更且有已知漏洞的 0.18.5 |
| Word 兜底 | 保留：没有转换软件时用前端库直接画（仅 docx） |
| PPT 兜底 | 不做前端库兜底；转换不了就说明原因并给出口 |
| Excel 兜底 | 不做简化表格；表格组件失败后转 PDF |
| PPT 界面 | 面板内从上往下滚、滚到附近才加载；全屏时一页一页放（与 Web 版最新做法一致） |
| 预先转换 | 第二期再做，本轮是打开时才转 |
| 分支 | 直接在 `desktop-mt` 上提交，不开新分支；推送目标 `origin/desktop-mt`，每次推送仍需当次确认 |
| 样例文件 | 由实施方在测试里生成，不需要用户提供 |

## 3. 现状与代码事实

以下均为阅读基线代码所得，不是运行结论。

| 项目 | 代码事实 | 本轮处理 |
| --- | --- | --- |
| 预览入口 | agent 工具、聊天里的文件卡片、文件树、附件都汇到 `src/store/preview.ts` 的 `openPreview`，再由 `preview-pane.tsx` 交给 `LocalFilePreview` | 入口不动，只在交给 `LocalFilePreview` 的那一处接入 |
| 类型判断 | 主进程 `previewFileTarget`（`electron/main.ts`）只分 html、image、pdf、text、binary 五种，Office 文件被判为 binary | 不改主进程；预览中心按扩展名再细分 |
| Office、音视频 | 在预览面板里落到“看起来是二进制文件”的提示页 | 改为各自的显示方式 |
| 聊天里的文件 | `markdown-text.tsx` 已把非媒体文件交给预览面板；音视频在聊天里已有内嵌播放器 | 不动 |
| 读文件 | 本机走 IPC：`readFileText` 返回前 512 KB，`readFileDataUrl` 默认上限 16 MB（可在设置里调）；远程走后端同名接口，上限 16 MB | 新格式先复用这两个接口，不新增读文件通道 |
| 音视频地址 | `src/lib/media.ts` 的 `resolveMediaPlaybackSrc` 已支持本机和远程，可拖进度 | 直接复用 |
| PDF 显示 | 用 Blob 地址放进 iframe，由 Chromium 内置阅读器显示 | Word 转出的 PDF 用同样做法 |
| 按表登记的写法 | `src/components/assistant-ui/embeds/registry.tsx` 是“名称 → 懒加载组件”的表，配错误边界 | 预览中心沿用这个写法 |
| 账号目录 | 主进程有 `ACCOUNT_RUNTIME.desktopState`，指向当前账号的桌面状态目录 | 转换缓存放在其下的 `office-preview/` |
| 多语言 | 分支专属文案（如 `cloudLibrary`）写进了全部语言文件和 `types.ts` | 新文案同样处理 |
| 隔离验证 | 已有 `scripts/*.native.mjs` 夹具，用独立 Electron 加载正式页面与 preload | 预览改造照此写夹具，不启动用户的后端 |
| 开发机转换软件 | 装有 MS Office 16 和 WPS（WPS 装在 D 盘非默认路径），没有 LibreOffice | LibreOffice 转换本机无法实测（见第 11 节） |

UniWork 与 Web 版里值得照搬和不能照搬的地方：

| 来源 | 照搬 | 不照搬及原因 |
| --- | --- | --- |
| UniWork 转换脚本（`routes/chat.py`） | 三种软件的调用方式、先后顺序、Excel 转 PDF 时按页宽缩放 | 转换结束无条件退出 Office，会关掉用户正开着的 PowerPoint；没有禁用宏；把文件路径拼进脚本文本 |
| UniWork 软件探测 | 查安装路径和注册表的思路 | 只凭 `Word.Application` 这类名字存在就认定是 MS Office；本轮改为查这个名字实际指向哪个程序 |
| UniWork 表格预览 | FortuneSheet 表格组件、样式／图片／图表的解析逻辑（三个文件共约 1300 行） | 一次搬完超出单步上限，拆成 P12～P15；压缩包读取改用仓库已有的 `fflate`，不再引入 JSZip |
| UniWork CSV | 表格样式、最多显示 500 行 | 解析器按换行切行，单元格里带换行会错位；本轮重写一个小解析器 |
| UniWork PDF 组件 | 无 | 运行时从外网下载一个文件，断网不可用 |
| Web 版转换类（`mtuser.py` 的 `OfficePreview`） | 缓存键用“真实路径＋大小＋修改时间”；同一文件只转一次；一次只跑一个转换；拷贝成英文文件名再转；LibreOffice 用独立配置目录，失败后清掉；大小与时间上限；缓存按份数和总量淘汰；带类型的失败原因 | 用 poppler 按页出图（Windows 桌面没有 poppler，本机改由前端从 PDF 逐页渲染）；按进程组结束进程的写法在 Windows 上不可用 |
| Web 版幻灯片查看器、音视频播放器 | 界面与交互 | 它们是“浏览器版才生效”的单独分支；本轮改为预览中心里的普通显示器 |

## 4. 方案概览

### 4.1 预览中心与目录

预览中心只做三件事，每件事只有一处代码负责：

1. 认类型：一张“扩展名 → 类型”的表。表里没有的类型原样交给现有预览。
2. 选显示方式：一张“类型 → 按顺序尝试的显示器”的表。前一个失败就换下一个，全部失败时说明原因并给出口。
3. 拿内容：一个文件负责取字节、取 Office 转出的 PDF。显示器不关心文件在本机还是远程。

新增目录（全部是新文件）：

```
src/app/chat/right-rail/formats/     预览中心
  kinds.ts             扩展名 → 类型
  registry.tsx         类型 → 显示器列表（懒加载）
  format-preview.tsx   入口：查表、逐个尝试、全部失败时的说明页
  failure.ts           失败原因
  source.ts            拿内容；“本机还是远程”只在这里判断
  *-preview.tsx        每种显示器一个文件
  sheet/               Excel 的解析与适配
electron/office-preview/             本机 Office 转换
  detect.ts            找本机装了哪种软件
  cache.ts             转换结果的缓存与淘汰
  jobs.ts              同一文件只转一次、一次只跑一个
  run-process.ts       启动子进程、超时结束
  com-scripts.ts       MS Office、WPS 的转换脚本
  convert-com.ts       调用上述脚本
  convert-libreoffice.ts
  service.ts           校验 → 查缓存 → 依次尝试各转换器
  ipc.ts               对前端暴露一个接口
shared/office-preview.ts             前端与主进程共用的约定：扩展名、上限、失败原因代码
```

需要改动的上游文件（除此之外不改上游文件）：

| 文件 | 改动 | 步骤 |
| --- | --- | --- |
| `src/app/chat/right-rail/preview-pane.tsx` | 渲染 `LocalFilePreview` 的那一处改为渲染 `FormatPreview`，连同引用共约 3 行 | P01 |
| `src/i18n/` 各语言文件与 `types.ts` | 在 `preview` 下追加新文案 | 用到的各步 |
| `shared/index.ts` | 导出约定文件，1 行 | P04 |
| `electron/main.ts` | 引入并注册转换服务，约 10 行 | P07 |
| `electron/preload.ts` | 新增 1 个桥接方法 | P07 |
| `src/global.d.ts` | 该方法的类型 | P07 |
| `apps/desktop/package.json`、根 `package-lock.json` | 新增依赖 | P03、P09、P10、P12、P15 |
| 根 `package.json` | FortuneSheet 需要的一条依赖覆盖（UniWork 已有同样配置；实施时确认是否仍需要） | P12 |

明确不改：`preview-file.tsx`、`src/lib/local-preview.ts`、`src/store/preview.ts`、`electron/media-protocol.ts`、Hermes Python 后端。

### 4.2 各类型的显示方式

| 类型 | 扩展名 | 依次尝试 | 全部失败时 |
| --- | --- | --- | --- |
| 文本、代码、Markdown、图片、PDF、HTML | 现有范围 | 现有预览，不改 | 现有行为 |
| 音频 | flac m4a mp3 ogg opus wav | 播放器 | 说明原因，给出口 |
| 视频 | avi mkv mov mp4 webm | 播放器，可拖进度 | 同上（avi、mkv 取决于 Chromium 能否解码） |
| CSV／TSV | csv tsv | 表格；可切到源码，源码仍可编辑 | 按文本显示 |
| TIFF | tif tiff | 解码第一页后按图片显示 | 给出口 |
| Word | docx doc odt | ① 本机转 PDF ② 前端库直接画（仅 docx） | 给出口，并提示安装 LibreOffice |
| PPT | pptx ppt odp | 本机转 PDF 后逐页显示，可全屏放映 | 给出口，并提示安装 LibreOffice |
| Excel | xlsx xls ods | ① 表格组件 ② 本机转 PDF | 给出口 |

“出口”指：本机是“在文件夹中显示”，远程是“下载”，两者都复用现有功能。现有桥接没有“用系统程序打开文件”，让页面能打开任意文件有安全风险，本轮不新增。

音视频的扩展名直接用 `src/lib/media.ts` 现有的表，不另抄一份。

### 4.3 新增依赖

| 库 | 用途 | npm 上查到的最新版（2026-10-13） | 许可证 | 引入步骤 |
| --- | --- | --- | --- | --- |
| `utif2` | TIFF 解码 | 4.1.0 | MIT | P03 |
| `docx-preview` | Word 兜底 | 0.4.1 | Apache-2.0 | P09 |
| `pdfjs-dist` | PDF 逐页渲染 | 6.4.299 | Apache-2.0 | P10 |
| `@fortune-sheet/react`、`@fortune-sheet/core` | 表格组件 | 1.0.4（UniWork 使用的版本，要求 React 18.2 及以上） | MIT | P12 |
| SheetJS（`xlsx`） | 读取表格文件 | npm 仓库停在 0.18.5；改用官方渠道的新版，版本号实施时确认 | Apache-2.0 | P12 |
| `echarts` | Excel 里的图表 | 6.1.0 | Apache-2.0 | P15 |

实际采用的版本以实施当天“发布满 14 天”的最新稳定版为准，写成精确版本号。不引入 UniWork 用到的 JSZip（改用仓库已有的 `fflate`）、`react-pdf`（直接用 `pdfjs-dist`）和 `pptx-viewer`（PPT 不做前端库兜底）。

### 4.4 本机 Office 转换

- 位置：Electron 主进程，前端通过一个新 IPC 调用。路径校验复用现有的读文件校验，不新开信任边界。
- 顺序：MS Office → WPS → LibreOffice。按 Word、PPT、Excel 分别判断是否可用（用户可能只装了其中一部分）。
- 缓存：键为“真实路径＋大小＋修改时间”，文件没变就不重转。放在 `<当前账号 desktopState>/office-preview/`，最多 30 份或 500 MB，超出时淘汰最久没用的。
- 上限：源文件 100 MB，转出的 PDF 50 MB，总耗时 180 秒。数值取自 Web 版，实施时可按实测调整。
- 排队：同一文件的重复请求共用一次转换；全局一次只跑一个转换。
- 转换前把源文件拷成英文文件名的副本再转，避免中文、空格文件名出问题，也不在用户工作区里留下临时锁文件。

移植 UniWork 脚本时必须修正的三点：

1. 不影响用户正在用的 Office。以只读、不显示窗口的方式打开；转换结束只关闭自己打开的那一份文件；只有当这个 Office 程序里没有别的文件开着时才退出它。
2. 打开文件前禁用宏。预览的可能是 agent 生成或外部来的文件。
3. 文件路径通过环境变量传给脚本，不拼进脚本文本，避免路径里的特殊字符破坏脚本。

超时处理：只结束“本次转换新启动、且没有可见窗口”的 Office 进程，绝不按进程名批量结束。

### 4.5 给云端预留什么

- `source.ts` 是唯一判断“本机还是远程”的地方。将来接云端，只在这里加一个来源，显示器不用改。
- 失败原因代码与 Web 版相同（太大、超时、转换失败、不可用、不支持、文件不存在等），前端按代码给出说明并决定是否尝试下一个显示器。
- 后端已有按路径下载文件的接口 `/api/fs/download`，没有 16 MB 的限制。将来取云端文件、下载到本机都可以用它，不需要改后端。
- 官方远程连接下本轮的预期表现（按设计推断，本轮不实测）：音视频、CSV 可用；TIFF、Excel 和 Word 的前端渲染可用，但受 16 MB 上限；PPT 说明原因并提供下载。

## 5. 小步修改与提交规则

- 每个 P 步骤以一个单一职责的本地提交为目标。业务代码超过 400 行就继续拆，不为凑步骤留下编译失败或悬空引用的中间态。
- 直接在 `desktop-mt` 上提交，不开新分支。每步开始先检查 Git 状态和远端是否有新提交；需要同步时先说明方式，不动用户未提交的本机文件。只暂存明确的文件，不执行 `git add .`。
- 每步开始重读根 `AGENTS.md`、`apps/desktop/AGENTS.md`、`apps/desktop/src/AGENTS.md`；涉及界面时对照 `apps/desktop/DESIGN.md`。
- 新增的每个命名函数／方法附简洁中文注释。
- 新代码放新文件。上游文件只做 4.1 清单里的改动，提交正文列出实际改了哪些上游文件。
- 用查表代替成串的条件判断。`formats/registry.tsx` 是显示器的唯一登记处，显示器之间不互相引用。
- 不为还没实施的能力预留空实现：函数、类型、文案在第一个用到它的步骤里才加入。
- 依赖写精确版本号，遵守根 `.npmrc` 的“发布满 14 天”规则，随 `package-lock.json` 一起提交。每个库只在第一次打开对应格式时才加载。
- 测试验证行为，不读源码文本，不写“数值一变就失败”的断言。依赖真实 Office 的转换测试只在装有对应软件的 Windows 上运行，不伪造系统；默认测试命令不启动 Office。
- 文案走现有多语言（`useI18n`），与 `cloudLibrary` 一样补齐全部语言文件。
- 提交标题为 `类型(范围): 简洁中文说明`；正文用通俗中文分段写清原问题、处理方式、行为边界、实际验证和未验证部分；“代码变化情况”按 `AGENTS.md` 的格式用一句话统计。
- 推送目标是 `origin/desktop-mt`。**每次推送都需要用户当次明确授权。**
- 不使用子 agent，不操作用户正在使用的窗口；验证只用独立目录、端口和窗口；不发送短信，不调用付费模型。
- 每步的固定检查：`npm run typecheck`、改动文件的 ESLint、相关 vitest、`git diff --check`。需要登录后才能看到的界面效果由用户在自己的窗口里核验，记为“待人工核验”，不写成已通过。
- 实施记录写在本文第 13 节和提交正文，不创建 `ACCEPTANCE.md`。
- 用户只要求生成本文时，完成文档提交后停止，不自动开始 P01。

## 6. 阶段 A：预览中心与不需要转换的格式

### P01 · 预览中心骨架与音视频

- 范围：新增 `formats/` 下的 `kinds.ts`、`registry.tsx`、`format-preview.tsx`、`failure.ts`、`media-preview.tsx` 及测试；`source.ts` 集中连接归属与失败出口；`preview-pane.tsx` 一处接入；文案。
- `kinds.ts`：扩展名到类型的表；音视频用 `lib/media.ts` 的 `mediaKind` 判断。表里没有的返回空，表示沿用现有预览。
- `registry.tsx`：类型到显示器列表的表，写法照 `embeds/registry.tsx`（懒加载＋错误边界）。
- `format-preview.tsx`：接收与 `LocalFilePreview` 相同的参数。类型为空时原样渲染 `LocalFilePreview`；否则按表逐个尝试，显示器报告失败就换下一个，文件已不存在时不再尝试；全部失败时用现有的 `PreviewEmptyState` 显示原因和出口。
- `media-preview.tsx`：参照 Web 版同名文件，播放地址来自现有的 `resolveMediaPlaybackSrc`。
- 骨架与第一个真实使用者（音视频）同步交付，不单独提交一个没有使用者的框架。
- 业务代码：约 330 行；文案约 40 行。
- 验证：新测试覆盖“每种已登记类型至少有一个显示器”“未登记类型仍走现有预览”“失败后换下一个，全部失败给出口”；现有 `preview-pane.test.tsx`、`preview-file.test.tsx` 保持通过；隔离夹具里打开 mp3、mp4，确认能播放、能拖动。
- 完成后可见：在文件树里打开音频、视频，会在预览面板里播放；其它文件的预览与现在完全一样。
- 提交方向：`feat(preview): 建立预览中心并支持音视频`。

### P02 · CSV／TSV 表格

- 范围：`formats/delimited-parse.ts`、`formats/delimited-preview.tsx` 及测试；登记；文案。
- 解析器支持引号、引号内的逗号与换行、`\r\n`；按扩展名决定分隔符。
- 内容用现有的 `readFileText` 读取（前 512 KB）。表头固定、带行号，最多显示 500 行；被截断或超过行数时在底部说明。
- 提供“表格／源码”切换。源码直接渲染现有的 `LocalFilePreview`，编辑、差异对比照旧可用。
- 解析失败时落到现有文本预览。
- 业务代码：约 250 行；文案约 20 行。
- 验证：解析器测试（引号、内嵌换行、空行、TSV）；隔离夹具里打开含中文和内嵌换行的 CSV；确认源码模式仍能编辑保存。
- 完成后可见：CSV 默认显示为表格，可切回源码编辑。
- 提交方向：`feat(preview): CSV 与 TSV 以表格预览`。

### P03 · TIFF 图片

- 范围：新增依赖 `utif2`；`formats/source.ts` 增加取文件字节；`formats/tiff-preview.tsx` 及测试；登记；文案。
- `source.ts` 的取字节函数基于现有的 `readDesktopFileDataUrl`，因此本机、远程都可用，上限沿用现有的 16 MB。超过上限时报告“太大”。
- 解码第一页，转成 PNG 后按图片显示；多页时说明只显示第一页（与 UniWork 一致）。
- 业务代码：约 150 行；文案约 10 行。
- 验证：取字节函数的测试；用测试里生成的 TIFF 在隔离夹具中打开；确认超限时显示“太大”而不是空白。
- 完成后可见：TIFF 图片可以预览。
- 提交方向：`feat(preview): 支持 TIFF 图片预览`。

## 7. 阶段 B：本机 Office 转换

本阶段四步都在 Electron 主进程，前三步对界面没有可见变化，P07 结束时转换可以从开发者工具调用，Word、PPT 的界面在阶段 C 接上。

### P04 · 转换约定与软件探测

- 范围：`shared/office-preview.ts`、`shared/index.ts` 导出 1 行；`electron/office-preview/detect.ts` 及测试。
- 约定文件：按 Word、PPT、Excel 分组的扩展名；三项上限；失败原因代码；转换结果的形状。前端和主进程共用，将来云端也按它对接。
- 探测 MS Office 与 WPS：查 COM 名字实际指向的程序（`reg query` 读 `CLSID` 和 `LocalServer32`），按程序文件名区分是哪家软件。这样能找到装在非默认路径的 WPS，也不会把“兼容模式下顶替了 MS Office 名字的 WPS”误认成 MS Office。
- 探测 LibreOffice：按顺序检查 PATH 和常见安装位置，写法照 `electron/git-binary-candidates.ts`（候选列表是纯函数，文件系统可注入）。
- 探测结果在进程内缓存；转换报告“不可用”时作废重查。
- 业务代码：约 290 行。
- 验证：用注入的注册表输出和文件系统测试各种组合（只有 WPS、只有部分 MS Office 组件、都没有、WPS 顶替了名字）；在开发机上实际运行一次，结果应为 MS Office 与 WPS 的三类组件均可用、LibreOffice 不可用。
- 提交方向：`feat(preview): 新增 Office 转换约定与本机软件探测`。

### P05 · 转换缓存与排队

- 范围：`electron/office-preview/cache.ts`、`jobs.ts` 及测试。
- 缓存：每个源文件一个目录，存 PDF 和一份说明（转换器、时间）；转换先写到临时目录，成功后原子改名发布；读取时刷新“最近使用”；按份数和总量淘汰，始终保留最新的一份；启动时清理超过 1 小时的残留临时目录。
- 排队：同一缓存键的并发请求共用一个结果；不同文件依次执行；调用方中途离开不取消已开始的转换。
- 业务代码：约 260 行。
- 验证：在临时目录上测试淘汰（超份数、超总量、保留最新）、原子发布、并发去重和先后顺序。
- 提交方向：`feat(preview): 新增 Office 转换缓存与排队`。

### P06 · MS Office 与 WPS 转换

- 范围：`electron/office-preview/run-process.ts`、`com-scripts.ts`、`convert-com.ts` 及测试；`scripts/office-preview.native.mjs` 实机夹具。
- `run-process.ts`：隐藏窗口启动子进程（复用 `hiddenWindowsChildOptions`），限制输出大小，超时后结束进程树。
- `com-scripts.ts`：Word、PPT、Excel 三类脚本，MS Office 与 WPS 共用结构、只换程序名。包含 4.4 的三点修正和超时处理所需的进程记录。Excel 沿用 UniWork 的“每张表缩到一页宽”。
- `convert-com.ts`：准备环境变量、调用脚本、检查产出的 PDF 存在且非空，把各种失败归到约定的原因代码。
- 业务代码：约 340 行。
- 验证：脚本选择与参数的单元测试；用假执行器测试超时路径。实机夹具在开发机上分别用 MS Office 和 WPS 转换测试里生成的含中文的 docx、pptx、xlsx，并检查：先手动打开一个 PowerPoint 文件再转换，转换后该文件仍然开着。实机夹具不进默认测试命令。
- 提交方向：`feat(preview): 支持用 MS Office 与 WPS 转换 PDF`。

### P07 · LibreOffice 转换、转换服务与接入

- 范围：`electron/office-preview/convert-libreoffice.ts`、`service.ts`、`ipc.ts` 及测试；`electron/main.ts`、`electron/preload.ts`、`src/global.d.ts` 的接入。
- LibreOffice：参数与独立配置目录的做法取自 Web 版；失败或超时后清掉配置目录。
- `service.ts`：校验扩展名和大小 → 查缓存 → 排队 → 拷贝英文名副本 → 按顺序尝试可用的转换器 → 检查 PDF 大小 → 发布并淘汰旧缓存。失败以原因代码返回，不抛出只有文字的异常。
- `ipc.ts`：一个接口，成功返回 PDF 字节、版本号和所用转换器，失败返回原因代码。
- 业务代码：约 280 行。
- 验证：用假转换器测试顺序与降级（第一个失败用第二个、全部失败的原因、缓存命中不再转换、超限）；隔离夹具里从页面调用接口拿到 PDF，第二次调用直接命中缓存。LibreOffice 转换在开发机上只有单元测试，记为未实测。
- 提交方向：`feat(preview): 接入本机 Office 转换服务`。

## 8. 阶段 C：Word 与 PPT

### P08 · Word 预览（转 PDF）

- 范围：`formats/source.ts` 增加“取 Office 转出的 PDF”；`formats/office-pdf-preview.tsx` 及测试；登记 Word 类型；文案。
- 本机调用 P07 的接口；远程直接报告“不可用”，由下一个显示器接手。
- 转换期间显示加载状态和“首次打开需要几秒”的说明；拿到 PDF 后用 Blob 地址放进 iframe，与现有 PDF 预览一致。
- 文件被改动后（现有的文件监视会触发重新加载）按新的修改时间重新转换。
- 业务代码：约 190 行；文案约 60 行（含各失败原因的说明）。
- 验证：显示器在“转换中、成功、各类失败”下的测试；隔离夹具里打开 docx、doc，确认显示、缓存命中后秒开、修改文件后刷新。
- 完成后可见：Word 文件在预览面板里以原样版式显示。
- 提交方向：`feat(preview): Word 文件转 PDF 预览`。

### P09 · Word 兜底（前端直接画）

- 范围：新增依赖 `docx-preview`；`formats/docx-preview.tsx` 及测试；登记为 Word 的第二个显示器（仅 docx）。
- 参照 UniWork 的 `DocxViewer.tsx`：按页渲染，页面随面板宽度缩放。字节来自 P03 的取字节函数。
- 渲染后去掉文档里链接的跳转能力，只显示文档内嵌的内容。
- 业务代码：约 190 行。
- 验证：测试“转换不可用时落到本显示器”；人工检查时临时把它调到第一位查看效果，提交前还原顺序。
- 完成后可见：没装任何 Office 软件、或处于远程连接时，docx 仍能看内容（版式可能有偏差）。
- 提交方向：`feat(preview): Word 在无法转换时用前端渲染兜底`。

### P10 · PDF 逐页渲染

- 范围：新增依赖 `pdfjs-dist`；`formats/pdf-pages.ts` 及测试。
- 从 PDF 字节得到“页数、页面尺寸、取第 N 页图片”的接口；图片按长边 1600 像素渲染，最近用过的若干页留在内存里，其余释放。pdf.js 的工作线程随程序打包，不从外网加载。
- 这是当前前端里第一个工作线程，需要确认开发模式和打包后都能加载。
- **放行条件**：用开发机的 MS Office 和 WPS 各转一份含中文的 PPT，逐页渲染无缺字、无乱码。不满足时本步改为方案 B：PPT 直接用 P08 的 PDF 显示方式（滚动看），全屏放映延后，并向用户说明。
- 业务代码：约 150 行。
- 验证：内存中页面的保留与释放测试；按放行条件做实机检查。
- 提交方向：`feat(preview): 新增 PDF 逐页渲染`。

### P11 · 幻灯片查看器

- 范围：`formats/slides-preview.tsx` 及测试；登记 PPT 类型；文案。
- 参照 Web 版 `office-slides.tsx`：面板里所有页竖排，先按比例占位，滚到附近才取图；顶部页码随滚动变化；全屏时一页一页放，支持方向键、空格、Home、End，从当前页开始，退出后停在放到的那一页。
- 页面来源是 P08 的 PDF 加 P10 的逐页渲染。查看器只认“页数、尺寸、取第 N 页”这个接口，将来云端可以换成服务器出的图。
- 业务代码：约 340 行；文案约 60 行。
- 验证：移植 Web 版查看器的测试（当前页计算、按需加载、全屏进出）；隔离夹具里打开 30 页以上的 pptx，检查滚动、页码、全屏和键盘。
- 完成后可见：PPT 可以滚动浏览和全屏放映。
- 提交方向：`feat(preview): PPT 逐页预览与全屏放映`。

## 9. 阶段 D：Excel

UniWork 的表格预览由三个文件组成，共约 1300 行，并依赖表格组件、SheetJS 和图表库。本阶段按“先能看、再好看”拆成四步，每步结束都是可用状态。

### P12 · Excel 基础表格

- 范围：新增依赖 `@fortune-sheet/react`、`@fortune-sheet/core`、SheetJS；`formats/sheet/model.ts`、`formats/sheet/fortune.ts`、`formats/sheet-preview.tsx` 及测试；登记 Excel 类型（表格组件 → 转 PDF）；文案。
- `model.ts`：用 SheetJS 读出每张表的单元格值、显示文本、合并单元格、列宽行高；每张表最多 500 行。
- `fortune.ts`：转成表格组件的数据。
- `sheet-preview.tsx`：参照 UniWork 的 `FortuneXlsxViewer.tsx`，只读，可切换工作表，面板宽度变化时重新布局；界面语言跟随应用。
- 本步开始前先确认两件事：表格组件在当前 React 版本和构建配置下能正常渲染；SheetJS 官方渠道的安装方式与仓库的依赖规则不冲突。任何一项不成立先停下说明，不硬上。
- 预估约 400 行，接近上限；实施时若超出，拆成“解析”和“显示”两个提交。
- 验证：解析测试（多工作表、合并单元格、日期和数字格式、超过 500 行）；隔离夹具里打开 xlsx、xls，检查切表、滚动、调整面板宽度。
- 完成后可见：Excel 以可滚动、可切换工作表的表格显示，暂时没有颜色和边框。
- 提交方向：`feat(preview): Excel 以表格预览`。

### P13 · Excel 样式还原

- 范围：`formats/sheet/` 下新增主题与样式解析，扩充 `fortune.ts`；测试。
- 移植 UniWork 的主题色、字体、填充、边框、对齐解析，以及对应的单元格样式和边框数据。读取压缩包内的文件用仓库已有的 `fflate`。
- 业务代码：约 380 行。
- 验证：用测试里生成的带样式工作簿检查颜色、加粗、边框、对齐的解析结果；隔离夹具里与 Excel 中的显示对比。
- 完成后可见：表格带上原文件的颜色、字体和边框。
- 提交方向：`feat(preview): 还原 Excel 单元格样式`。

### P14 · Excel 图片

- 范围：`formats/sheet/` 下新增绘图解析，扩充 `fortune.ts`；测试。
- 移植 UniWork 的图片位置、裁剪解析和图片数据生成。
- 业务代码：约 310 行。
- 验证：含图片的工作簿，检查位置和大小的解析；隔离夹具里查看。
- 完成后可见：表格里嵌入的图片显示在原位置。
- 提交方向：`feat(preview): 显示 Excel 内嵌图片`。

### P15 · Excel 图表

- 范围：新增依赖 `echarts`；`formats/sheet/` 下新增图表解析与绘制；测试。
- 移植 UniWork 的图表解析和“画成图片放进表格”的做法。图表库只在工作簿确实含图表时才加载。
- 业务代码：约 270 行。
- 本步需要多引入一个较大的库。默认排在最后实施；用户若不希望引入，可以整步取消，其余步骤不受影响。
- 验证：含柱状图、折线图、饼图的工作簿，检查系列与分类的解析；隔离夹具里查看。
- 完成后可见：表格里的图表显示在原位置。
- 提交方向：`feat(preview): 显示 Excel 内嵌图表`。

## 10. 阶段 E：收尾

### P16 · 降级说明、文档与回归

- 范围：完善全部失败时的说明页（三种软件都没有时提示安装 LibreOffice；远程时提供下载）；更新 `README.md`、`USAGE.md` 中与预览有关的现状说明和人工验收步骤；补全本文的实施记录。
- 完整运行 `npm run check:lint`、`npm run test:ui`、`npm run test:desktop:platforms`，如实记录通过、失败和跳过。
- 业务代码：约 120 行。
- 提交方向：`docs(desktop-mt): 记录文件预览改造验收与现状`（若含代码改动则拆成两个提交）。

## 11. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 转换时影响用户正在用的 Office | 4.4 的三点修正；P06 的实机检查专门验证“已打开的 PowerPoint 不被关闭” |
| Office 弹出激活、首次运行等对话框导致转换卡住 | 总耗时上限 180 秒，超时后只结束本次新启动且无窗口的进程，并尝试下一个转换器 |
| LibreOffice 转换在开发机上无法实测 | 单元测试覆盖参数与失败处理，标记为未实测；需要在装有 LibreOffice 的机器上补一次实机检查 |
| 表格组件与当前 React 或构建配置不兼容 | P12 开始前先验证；UniWork 在 React 19 上使用同一版本，风险较低；不成立时停下说明 |
| pdf.js 渲染转出的 PDF 缺中文字 | P10 的放行条件与方案 B |
| SheetJS 官方渠道不是 npm 仓库，打包机需要能访问该地址 | P12 开始前确认；不行时改为把安装包放进仓库，需用户同意 |
| 新增库使安装包变大 | 全部懒加载；P16 记录安装包体积变化 |
| 本机超过 16 MB 的 Excel、TIFF 无法预览 | 明确提示“太大”并给出口；流式读取列入第 12 节 |
| 与 `feat/hermes-ch` 各有一份幻灯片查看器和音视频播放器 | 两个分支目前不合并；将来同步时以预览中心为准，把 Web 版的服务器出图接成一个页面来源 |
| 改动上游文件带来同步冲突 | 只改 4.1 清单里的几处，每处几行；同步上游后按清单核对 |

## 12. 后续（不在本轮）

- 文件卡片一出现就在后台预先转换 Word、PPT（UniWork 有此行为，Web 版没有）。
- 超大文件的流式读取：让表格、TIFF 不受 16 MB 限制，让转出的 PDF 不必整份放进内存。
- 云端来源：在 `source.ts` 接入 Web 版部署层已有的转换接口和后端的下载接口。
- 个人云盘文件接入预览中心。
- 与 `feat/hermes-ch` 的查看器合并为一份。

## 13. 实施进度

| 阶段 | 步骤 | 当前状态 |
| --- | --- | --- |
| A · 预览中心与音视频 | P01 | 已实现并自动验证，待用户核验；本地提交，未推送 |
| A · CSV／TSV | P02 | 未开始 |
| A · TIFF | P03 | 未开始 |
| B · 约定与探测 | P04 | 未开始 |
| B · 缓存与排队 | P05 | 未开始 |
| B · MS Office 与 WPS 转换 | P06 | 未开始 |
| B · LibreOffice、服务与接入 | P07 | 未开始 |
| C · Word 转 PDF | P08 | 未开始 |
| C · Word 兜底 | P09 | 未开始 |
| C · PDF 逐页渲染 | P10 | 未开始 |
| C · 幻灯片查看器 | P11 | 未开始 |
| D · Excel 基础表格 | P12 | 未开始 |
| D · Excel 样式 | P13 | 未开始 |
| D · Excel 图片 | P14 | 未开始 |
| D · Excel 图表 | P15 | 未开始 |
| E · 收尾 | P16 | 未开始 |

业务代码预估合计约 4200 行，分 16 步，单步不超过 400 行。各步的实施记录在完成后追加到本节之后。

### P01 实施记录（2026-10-13）

- 动手前核对本地与远端均为 `58a9d13a9b`，无需同步；重新核查预览入口、媒体通道与账号分区，不按旧基线猜测实现。
- 预览面板的一处文件入口改为 `FormatPreview`。音视频用原版扩展名判断、懒加载播放器和 `resolveMediaPlaybackSrc`；不自动播放，复用既有流式读取与进度拖动。AVI、MKV 等仍取决于 Chromium 的编码支持，失败给出说明。
- 其余格式原样交给 `LocalFilePreview`，保留原参数及回调。`preview-file.tsx`、`lib/local-preview.ts`、`store/preview.ts`、媒体协议和 Hermes Python 后端均未改。
- 显示器登记、失败降级与错误边界已接通。明确 `not_found` 时停止继续尝试，未知内部错误不显示路径或异常详情。失败时提供本机文件夹入口或远程下载，关闭入口仍可用。
- `source.ts` 在本步已有真实用途：集中确定连接归属与失败出口，按连接、Profile、路径和刷新次数隔离加载状态，远程下载固定原归属。P03 再在此增加取字节，不另建判断本机／远程的位置。
- 新文案补齐全部九种语言与类型定义。没有新增依赖、读文件 IPC、预览默认设置或文件预转换。

自动检查：

- `npm run typecheck` 通过；本步改动文件的 ESLint 零警告；原生夹具语法与 `git diff --check` 通过。
- `npx vitest run --project ui src/app/chat/right-rail/formats/format-preview.test.tsx src/app/chat/right-rail/preview-pane.test.tsx src/app/chat/right-rail/preview-file.test.tsx src/i18n/catalog-completeness.test.ts`：4 个文件，65 项通过。
- `npx vitest run --project electron electron/media-protocol.test.ts electron/media-range.test.ts`：2 个文件，27 项通过。
- `node --test scripts/file-preview.native.mjs`：1 项综合检查通过。样例由指定的本机 FFmpeg 生成；正式 Vite 生产配置构建独立预览入口，使用正式 preload、文件校验、媒体协议与 Range 响应，没有启动 Hermes 后端或登录 MaaS。
- 实际验证 MP3、H.264 MP4 解码播放、程序化跳转、鼠标拖动 Chromium 原生进度条、206 分段读取，以及损坏 MP4 的失败界面与文件夹 IPC。测试文件夹入口由夹具记录请求，不真正打开用户的文件管理器。截图位于 `C:\Users\stan\AppData\Local\Temp\hermes-file-preview-e9DJIE`。
- 早期夹具的开发依赖扫描超时、隐藏窗截图、错误 IPC 名称和未唤出视频控件问题已修正；上述通过结果来自修正后的整组复测，未降低播放、拖动或失败出口断言。生产构建仍报告既有的分块弃用及无效动态导入警告。

证据边界：远程下载归属与切换由组件测试覆盖，未连接真实远程服务器；未验证其它媒体编码、macOS、Linux 或安装包。用户登录后从文件树打开音视频的界面核验仍待完成。按计划停在 P01，未实施 P02，也未推送。
