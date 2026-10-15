# 文件预览改造实施计划

日期：2026-10-13。基线：`desktop-mt @ d5ff498050`（代码事实核对于同步远端 `40caef7b87` 之前，P01 动手前需复核）。参考实现：UniWork 桌面版 `Kyle549/UniClaw @ uniwork_release`（`8ae3548e`）、Web 版 `feat/hermes-ch`（`3bef1c5bd4`）。

状态：P01～P14 已推送，P14 为 `6d32b6b33b`。P15 已完成 XLSX 内嵌图表和定向检查，本步拆为公共绘图整理与图表功能两个本地提交、未推送；真实桌面文档排版仍待用户核验。P16 未开始。复杂文档、Office 已有文档并行仍待人工验收；P04 同厂家多个备用入口仍未实现。本文不授权推送。每步完成验证并本地提交后暂停，等待用户核验，再继续下一步。

Web 对齐补充（2026-10-14）：核对已抓取的 `origin/feat/hermes-ch @ 07579969c5`。`office-slides.tsx` 的 PPT 主交互仍是竖排按需加载与全屏逐页；Word 也使用了分页图片，但不提供放映。本分支只参考适合桌面的交互，不合并 Web 登录、浏览器桥接、服务器转换和部署代码；Word 现有显示方式不在 P11 改动。

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
| `src/app/chat/right-rail/preview-file.tsx` | 只给已有的 `filePathForTarget` 加上导出，供预览中心与原版预览共用同一套取路径算法；函数内容不变，1 处 | 审阅修复 |
| `src/i18n/` 各语言文件与 `types.ts` | 在 `preview` 下追加新文案 | 用到的各步 |
| `shared/index.ts` | 导出约定文件，1 行 | P04 |
| `apps/desktop/tsconfig.electron.json` | 将新共享约定文件加入 Electron 编译清单，1 处 | P04 |
| `electron/main.ts` | 引入并注册转换服务，约 10 行 | P07 |
| `electron/preload.ts` | 新增 1 个桥接方法 | P07 |
| `src/global.d.ts` | 该方法的类型 | P07 |
| `apps/desktop/package.json`、根 `package-lock.json` | 新增依赖 | P03、P09、P10、P12、P15 |
| `apps/desktop/vite.config.ts` | 注册本地 PDF 资源插件，导入与登记共 3 行；新增 `pdf-assets.ts` 提供开发资源及构建输出 | P10 |
| 根 `package.json` | FortuneSheet 需要的一条依赖覆盖（UniWork 已有同样配置；实施时确认是否仍需要） | P12 |

明确不改：`preview-file.tsx` 的现有逻辑（上表的导出除外）、`src/lib/local-preview.ts`、`src/store/preview.ts`、`electron/media-protocol.ts`、Hermes Python 后端。

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
| SheetJS（`xlsx`） | 读取表格文件 | 0.20.3，固定官方 CDN 包地址；不用 npm 的 0.18.5 | Apache-2.0 | P12 |
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

1. 不影响用户正在用的 Office。以只读、不显示窗口的方式打开；转换结束只关闭自己打开的那一份文件；只退出本次新建、没有其它文件且没有可见窗口的实例，不退出已经存在的实例。
2. 打开文件前禁用宏。预览的可能是 agent 生成或外部来的文件。
3. 文件路径通过环境变量传给脚本，不拼进脚本文本，避免路径里的特殊字符破坏脚本。

超时处理：只结束“本次转换新启动、准确 PID／创建时间／程序路径仍匹配、没有其它文件且没有可见窗口”的 Office 进程，绝不按进程名批量结束。不能确认收尾时停止本轮降级并保留记录，不继续启动其它转换器；P07 接线必须遵循此规则。

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
- 用户已明确要求减少测试耗时，并由用户承担真实验收。后续优先完成定向自动检查，不反复搭建原生夹具；涉及真实桌面或软件的验收可交由用户执行，如实标记未验证项。
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
- 探测 MS Office 与 WPS：一次隐藏 PowerShell 通过 Windows 注册表 API 只读查询 `CLSID`、必要时的 `CurVer` 和 `LocalServer32`（优先 `ServerExecutable`），按程序文件名区分厂家，并保留 32／64 位视图。这样能找到装在非默认路径的 WPS，也不会把“兼容模式下顶替了 MS Office 名字的 WPS”误认成 MS Office；不激活 COM。
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
- `run-process.ts`：隐藏窗口启动辅助进程（复用 `hiddenWindowsChildOptions`），限制输出大小，超时后结束直接启动的辅助进程。Office 是独立 COM 服务，另按准确归属记录清理，不对它执行不加区分的进程树终止。
- `com-scripts.ts`：Word、PPT、Excel 三类脚本，MS Office 与 WPS 共用结构、只换程序名。包含 4.4 的三点修正和超时处理所需的进程记录。Excel 沿用 UniWork 的“每张表缩到一页宽”。
- `convert-com.ts`：准备环境变量、调用脚本、检查产出的 PDF 存在且非空，把各种失败归到约定的原因代码。
- 业务代码：约 340 行。
- 验证：脚本选择与参数的单元测试；用假执行器测试超时路径。实机夹具在开发机上分别用 MS Office 和 WPS 转换测试里生成的含中文的 docx、pptx、xlsx，并检查：先手动打开一个 PowerPoint 文件再转换，转换后该文件仍然开着。实机夹具不进默认测试命令。
- 提交方向：`feat(preview): 支持用 MS Office 与 WPS 转换 PDF`。

### P07 · LibreOffice 转换、转换服务与接入

- 范围：`electron/office-preview/convert-libreoffice.ts`、`service.ts`、`ipc.ts` 及测试；`electron/main.ts`、`electron/preload.ts`、`src/global.d.ts` 的接入。
- LibreOffice：沿用独立配置目录和无界面转换；仅确认安全收尾后删除配置，超时或异常终止且不能确认后代状态时保留记录，不强杀用户软件。
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
- `model.ts`：用 SheetJS 读出每张表的单元格值、显示文本、合并单元格、列宽行高；每张表最多 500 行。二维网格按工作簿累计最多 250000 格，合并区域展开也有同样上限，超限交给 PDF 候选。
- `fortune.ts`：转成表格组件的数据。
- `sheet-preview.tsx`：参照 UniWork 的 `FortuneXlsxViewer.tsx`，只读，可切换工作表，面板宽度变化时重新布局；界面语言跟随应用。
- 本步开始前先确认两件事：表格组件在当前 React 版本和构建配置下能正常渲染；SheetJS 官方渠道的安装方式与仓库的依赖规则不冲突。任何一项不成立先停下说明，不硬上。
- 预估约 400 行，接近上限；实施时若超出，拆成“解析”和“显示”两个提交。
- 验证：解析测试（多工作表、合并单元格、日期和数字格式、超过 500 行）；隔离夹具里打开 xlsx、xls，检查切表、滚动、调整面板宽度。
- 完成后可见：Excel 以可滚动、可切换工作表的表格显示，暂时没有颜色和边框。
- 提交方向：`feat(preview): Excel 以表格预览`。

### P13 · Excel 样式还原

- 范围：`formats/sheet/` 下新增主题与样式解析，扩充 `fortune.ts`；测试。
- 参考 UniWork 的 XLSX 主题色、字体、填充、边框、对齐解析，以及对应的单元格样式和边框数据。读取压缩包内的文件用仓库已有的 `fflate`；XLS／ODS 保留 P12 基础预览，不宣称完整样式还原。
- 业务代码：约 380 行。
- 验证：生成带样式工作簿，检查颜色、字体、边框、对齐及正式画布；与 Excel 中的真实排版对照交由用户验收，不反复启动 Office。
- 完成后可见：表格带上原文件的颜色、字体和边框。
- 提交方向：`feat(preview): 还原 Excel 单元格样式`。

### P14 · Excel 图片

- 范围：`formats/sheet/` 下新增绘图解析，扩充 `fortune.ts`；测试。
- 参考 UniWork 的 XLSX 图片位置、裁剪解析和图片数据生成。支持包内 PNG／JPEG／GIF／WebP／BMP；不加载外链或直接插入文件自带的 SVG。XLS／ODS 仍保留基础预览。
- 业务代码：约 310 行。
- 验证：含图片的工作簿，检查位置和大小的解析；隔离夹具里查看。
- 完成后可见：表格里嵌入的图片显示在原位置。
- 提交方向：`feat(preview): 显示 Excel 内嵌图片`。

### P15 · Excel 图表

- 范围：新增依赖 `echarts`；`formats/sheet/` 下新增图表解析与绘制；测试。
- 参考 UniWork 的 XLSX 图表解析和“画成图片放进表格”的做法。图表库只在工作簿确实含图表时才加载，按需引入需要的类型与 SVG 渲染器；XLS／ODS 图表不在本步实现。
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
| Office 弹出激活、首次运行等对话框导致转换卡住 | 总耗时上限 180 秒，只结束归属明确且无窗口的本次新建进程；确认安全收尾后才尝试下一个转换器，不能确认时保留记录并停止降级 |
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
| A · 预览中心与音视频 | P01 | 已实现并自动验证，已推送 `df151293dd` |
| A · CSV／TSV | P02 | 已实现，定向检查通过；已推送 `aaaea847f5`，真实桌面验收待用户完成 |
| A · TIFF | P03 | 已实现，定向检查通过；已推送 `f63ae9e9cc`，真实桌面验收待用户完成 |
| B · 约定与探测 | P04 | 已推送 `4275f8f2a2`；查询异常及主要 WPS 别名、专用入口优先级已修复；同厂家备用入口仍有限制 |
| B · 缓存与排队 | P05 | 已实现，13 项定向检查通过；已推送 `e7f05d4015`，应用接线待 P07 |
| B · MS Office 与 WPS 转换 | P06 | 已推送至 `7bf5fe50b3`；38 项定向检查通过，两厂家三类真实转换取得 PDF，排版及已有文档并行待人工确认 |
| B · LibreOffice、服务与接入 | P07 | 已推送 `26bcd424a6`；预览模块 60 项、独立 Electron IPC／缓存命中通过，真实软件接线仍待人工核验 |
| C · Word 转 PDF | P08 | 已推送 `6811e87775`；docx／doc／odt 定向检查通过，真实排版、再次打开速度和文件保存后刷新待用户核验 |
| C · Word 兜底 | P09 | 已推送 `1766d565ef`；44 项定向检查通过，真实排版与缩放待用户核验 |
| C · PDF 逐页渲染 | P10 | 已推送 `995d7f1de3`；19 项组件检查及开发／生产文件模式真实 Worker 通过，两厂家中文样例图像对照放行 |
| C · 幻灯片查看器 | P11 | 已推送 `3d6e991adf`；32 页受控组件检查通过，真实桌面长 PPT／全屏待用户核验 |
| D · Excel 基础表格 | P12 | 已推送 `89380bba58`；54 项定向检查和三格式原生显示器检查通过，真实文档排版待用户核验 |
| D · Excel 样式 | P13 | 已推送 `c00583593c`；60 项相关检查、三格式及 XLSX 样式原生画布通过，复杂文件与 Excel 对照待用户核验 |
| D · Excel 图片 | P14 | 已推送 `6d32b6b33b`；46 项定向检查及真实 Electron 图片检查通过，用户复杂文件待核验 |
| D · Excel 图表 | P15 | 已实现，两个本地提交未推送；33 项定向检查及正式 Electron 三类图表与按需加载通过，复杂图表待用户核验 |
| E · 收尾 | P16 | 未开始 |

P01～P16 业务代码预估合计约 4200 行，单步不超过 400 行。各步的实施记录在完成后追加到本节之后。

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

证据边界：远程下载归属与切换由组件测试覆盖，未连接真实远程服务器；未验证其它媒体编码、macOS、Linux 或安装包。用户登录后从文件树打开音视频的界面核验仍待完成。`df151293dd` 已按用户当次授权推送；用户确认保持聊天内嵌播放器现状，继续实施 P02。

### P02 实施记录（2026-10-13）

- CSV、TSV 在预览中心登记为表格类型，显示器懒加载。仍使用既有文件卡片入口，没有修改聊天内嵌播放器、Hermes 后端或读文件 IPC，也没有新增依赖。
- 通过 `source.ts` 复用原文本读取及前 512 KB 上限。逗号或制表符由扩展名确定；支持 UTF-8 BOM、引号内分隔符与换行、双引号转义、CRLF、空字段和空记录。非法引号或读取失败交回原版预览。
- 第一条记录作为表头，显示行号，最多显示 500 条数据记录；列数不齐时保留额外列。读取被截断时不展示末尾可能残缺的记录，并分别提示文本读取截断与数据行数超限。
- 提供源码切换，源码查看、编辑和差异继续交给原版 `LocalFilePreview`。有未保存修改时禁止切回表格；保存或取消后返回表格会重新读取文件，避免显示旧内容。
- 表格模式与限制文案补齐全部九种语言与类型定义。新增命名函数均有简洁中文注释。

定向检查：

- CSV／TSV 解析、表格组件、预览中心、原版文件预览及翻译完整性共 5 个文件、59 项通过。首轮 58 项通过、1 项失败，原因是测试把单元格换行误写为空格；改为核对真实单元格文本后，单独复测 CSV 组件 7 项全部通过。
- `npm run typecheck`、改动文件 ESLint 零警告、`git diff --check` 通过。
- 按用户最新要求，本步未启动真实 Electron 夹具。中文多行 CSV／TSV 的实际表格排版、固定表头、源码编辑保存和返回表格刷新由用户验收，未写成已经实测。
- 人工样例：`C:\Users\stan\AppData\Local\Temp\hermes-preview-p02-samples-20261013\quoted.csv` 与同目录 `sample.tsv`。在项目文件树打开，检查中文、单元格换行／引号；切到源码修改并保存，再回表格确认更新；未保存时应禁止切回。

`aaaea847f5` 已按用户当次“推送，然后继续”授权推送到 `origin/desktop-mt`；随后开始 P03。推送不代表真实桌面验收已经完成。

### P03 实施记录（2026-10-13）

- 新增 `.tif`、`.tiff` 登记与懒加载显示器。按 `utif2` 的 `decode → decodeImage → toRGBA8` 解码第一页，再由本机 Canvas 转为 PNG 显示；没有上传文件、外网转换或新增读取 IPC。
- 精确依赖 `utif2@4.1.0`，npm 元数据确认该版发布于 2023-05-06，满足发布满 14 天规则；阅读安装包自带 README 与类型定义后使用，没有另加类型依赖。根锁文件仅新增该包及其 `pako@1.0.11` 依赖。
- `source.ts` 的取字节函数复用 `readDesktopFileDataUrl` 和既有 Data URL 解码工具，本机仍使用原设置的读取上限（默认 16 MB、可调整），远程沿用原接口的 16 MB 上限。本机 IPC 丢失错误字段时识别原有固定消息；超限、文件不存在和其它错误统一为预览失败代码，不展示内部路径或异常文本。
- 多页文件只显示第一页并说明；不遍历或解码后续页。清理的是字节副本中的后续目录指针，原文件及原始输入不变。损坏、截断、库不支持的压缩或色彩类型给出失败出口，不用空白图冒充成功。
- 除读取上限外，增加解码资源限制：最多 `32 × 1024 × 1024` 像素、任一边不超过 32767、原始像素缓冲不超过 128 MB；分配像素前检查。压缩文件很小但展开过大时也提示“太大”。没有添加新设置或流式读取。
- 刷新、关闭及切换文件／连接后释放 PNG 地址，迟到结果不能覆盖新目标。本机失败出口仍为文件夹，远程为原连接下载；新文案补齐全部九种语言。
- 改动的上游文件只有 `apps/desktop/package.json`、根 `package-lock.json` 和 i18n 文件；其余位于本轮新建的 `formats/`。没有修改 `preview-file.tsx`、聊天文件卡片、内嵌播放器或 Hermes Python 后端。

定向检查与人工验收边界：

- TIFF 解码、显示器、字节来源、预览中心和翻译完整性共 4 个文件、52 项通过。解码使用库生成的真实单页／双页 TIFF，并核对首帧颜色；覆盖损坏、截断、尺寸超限、晚到读取及地址释放。
- 来源测试实际调用既有本机／远程读取封装，底层 IPC／网络响应受控；Canvas 与 PNG 编码由组件测试替身提供。因此不能把测试通过写成真实 Electron 图片已经显示。
- `npm run typecheck`、改动文件 ESLint 零警告、`git diff --check` 通过。首轮类型检查发现测试目标少了既有必填 `source` 字段，补齐后复查；未修改产品类型来放宽要求。
- 按用户要求没有启动原生 Electron、操作用户窗口或搭建额外原生夹具。真实桌面图片效果、远程服务器、其它 TIFF 编码、安装包及其它操作系统未实测。
- 人工样例目录：`C:\Users\stan\AppData\Local\Temp\hermes-preview-p03-VxonC2`。`single.tif` 应显示彩色渐变；`multi.tiff` 应显示同一第一页并提示多页（第二页为蓝色，不显示）；`broken.tif` 应提供失败出口；`large-dimensions.tiff` 应明确提示超限。可用原有项目文件树打开这些文件。

`f63ae9e9cc` 已按用户当次“推送，然后继续”授权推送到 `origin/desktop-mt`；随后开始 P04。TIFF 真实桌面验收仍由用户完成，未因推送改记为已实测。

### P04 实施记录（2026-10-13）

- 新增共享约定 `apps/shared/src/office-preview.ts`：Word、PPT、Excel 扩展名分组，转换器顺序、源文件 100 MB、PDF 50 MB、总耗时 180 秒，以及成功／失败结果形状。失败代码与本地已抓取 `origin/feat/hermes-ch` 的 `deploy/hermes-mt/seed/mtuser.py` 对齐（`too_large`、`timeout`、`convert_failed`、`unavailable`、`unsupported`、`not_found`）；没有改动该 Web 分支。
- 新增 `electron/office-preview/detect.ts`，返回每类文件的 MS Office → WPS → LibreOffice 候选。不凭 ProgID 名称认厂家，先查 COM 实际服务程序、验证真实文件，再按组件程序名分类；记录 ProgID 与 32／64 位视图，供后续调用正确位数的转换进程。同厂家的重复别名／视图只保留首个候选。
- 实施时把逐次 `reg query` 调整为一次隐藏 PowerShell，通过系统 `.NET RegistryKey` API 批量读取同样的注册表键。原因是避免反复启动辅助进程和本地化命令输出乱码；JSON 明确以 UTF-8 返回，句柄及时关闭。只读查询 `CLSID`、必要时的 `CurVer`、`LocalServer32`，优先使用命名值 `ServerExecutable`，不激活 COM、不启动 Office、不读写文档。
- 注册表读取限制为 10 秒与 256 KB 输出；查询异常上抛，不缓存成“未安装”。同一个探测器共享正在进行或已完成的查询；显式作废后重查，旧请求迟到失败不会清掉新请求。P07 将接入转换服务，本步没有新增 IPC、界面或自动启动探测。
- LibreOffice 按 PATH 与常见目录查找，排除相对路径及隐式当前目录搜索；程序必须是实际文件。Windows 在本机验证，macOS／Linux 只检查候选生成的纯函数，不伪造运行平台或声称已实测。
- 上游改动仅为 `apps/shared/src/index.ts` 导出一行，以及 `apps/desktop/tsconfig.electron.json` 增补一个共享源码路径。后者是 Electron composite 编译清单的必要接线，已加入第 4.1 节清单；未修改原版后端、窗口、预览组件、用户配置或 Office 注册表，也未新增依赖。

验证结果与边界：

- `npx vitest run --project electron electron/office-preview/detect.test.ts`：1 个文件、13 项通过。覆盖扩展名登记关系、只有 WPS、部分 MS Office、没有软件、微软别名被 WPS 占用、中文／非默认路径、`ServerExecutable` 优先、缺失／错误程序、候选顺序、重复去重、并发缓存、显式作废、异常重试与迟到请求。
- 测试中包含真实 Windows 只读查询；另外通过 `npx tsx -e` 直接调用正式 `createOfficeDetector().get()`，未使用替身，确认三类文件均有 MS Office 与 WPS 候选、LibreOffice 未找到。MS Office 来自 64 位登记，路径在 `C:\Program Files\Microsoft Office\Root\Office16`；WPS 来自 32 位登记，路径在 D 盘，部分微软 ProgID 实际指向 WPS。结果保留这些位数，不把 WPS 误认成微软组件。
- `npm run typecheck`、修改文件 ESLint 零警告和 `git diff --check` 通过。自动测试只花费定向检查，不运行全套桌面或 Office 原生转换夹具。
- 本步确认的只是注册表与文件路径可识别，不保证 COM 激活、授权、宏控制、文档转换或 PDF 正确。未打开用户 Office 窗口、未转换 Word／PPT／Excel，也未验证 LibreOffice、其它操作系统或安装包。这些属于后续步骤和人工验收。
- 探测约定依据 [Microsoft LocalServer32](https://learn.microsoft.com/en-us/windows/win32/com/localserver32) 与 [RegistryKey.OpenBaseKey](https://learn.microsoft.com/en-us/dotnet/api/microsoft.win32.registrykey.openbasekey)；使用 `ServerExecutable` 的真实路径优先于命令行推断，不把注册表信息当作转换已经成功的证明。

P04 后续对照 UniWork `8ae3548e` 发现：COM 查询失败会阻断 LibreOffice 探测；候选缺少 `KWet.Application` 与部分 `.6` 名称；同厂家只保留首个入口会丢失备用 COM。前两项属于错误处理和覆盖问题，第三项是转换接线时的限制。用户明确“先不做，推送后继续”，因此当时未修改探测代码。（更新：查询异常已在“P01～P05 审阅修复记录”中解决，主要 WPS 别名和专用入口优先级已在本次 P06 修复中补齐，同厂家多个备用 COM 仍未实现。）

`4275f8f2a2` 已按用户当次授权推送到 `origin/desktop-mt`；随后开始 P05。

### P05 实施记录（2026-10-13）

- 新增 `electron/office-preview/cache.ts` 与 `jobs.ts`，不修改 P04 探测或其它上游产品文件，不新增依赖、IPC、设置项或界面。本步是转换服务的模块，P07 再接入正式应用；未声称现在已能预览 Office。
- 以源文件真实路径、大小和修改时间生成 SHA-256 缓存键，任一项变化就得到新版本。缓存实例固定在主进程提供的 `<账号 desktopState>/office-preview/`，相同外部文件在 A、B 账号下也不共享缓存。说明只存转换器和转换时间，不保存源路径或账号凭据。
- 转换临时目录与发布目录分开：PDF 和说明先写完，再通过同卷目录改名发布，读取不会看到半成品。正式缓存只保留 `doc.pdf` 与 `note.json`，不将源文件、Office 临时文件或 LibreOffice 配置带进缓存。源转换目录由调用方正常清理，崩溃遗留目录超过 1 小时在缓存首次准备／回收时清理。
- 缓存命中刷新最近使用时间；默认最多 30 份、总计 500 MB，超限按最久未用淘汰，始终保留最近一份。读取返回 PDF 字节而不是易失效的路径，之后淘汰不影响已经返回的内容。空 PDF 或超过 P04 的 50 MB PDF 上限不发布；丢失文件和坏说明视为未命中，权限或磁盘异常不伪装成正常未命中。
- 清理只作用于本缓存直属、名称受控的目录，拒绝越界路径、目录联接和符号链接，不清理用户其它目录。测试实际检查了 Windows 联接与外部哨兵文件：回收临时目录不会删除联接指向的内容。
- 一个队列一次只执行一个任务；去重键包含账号缓存范围和文件版本，不把不同账号相同文件的请求合并。相同进行中任务共享结果，界面离开不取消任务；成功和失败都释放队列，失败后允许后续显式重试，不自动循环重试。P07 将为服务共用一个队列，不为每个窗口重复建立队列。

定向检查与边界：

- `npx vitest run --project electron electron/office-preview/cache.test.ts electron/office-preview/jobs.test.ts`：2 个文件、13 项通过。缓存测试实际使用 Windows 临时目录和文件系统，没有文件系统替身；包含 A→B→A 读取、磁盘缓存重新打开、原子发布可见性、份数／总量淘汰、最新缓存保留、损坏说明恢复、空／超限产物、临时目录清理、联接和路径保护。
- 队列测试使用事件控制任务结束，无实际计时等待；检查去重、串行、不同账号不合并、失败后的继续执行与显式重试。另将正式队列和缓存一起执行，三个相同请求只生成一次夹具 PDF。
- `npm run typecheck`、修改文件 ESLint 零警告与 `git diff --check` 通过。定向测试执行约 0.8 秒，未追加真实 Electron 或 Office 转换夹具。
- PDF 为本轮生成的测试字节，只验证存储和调度，不等于 PDF 渲染、真实 Office 转换或应用重启链路已验收；重新打开缓存实例仅证明磁盘结果可复用。测试只创建并清理自身临时目录，没有读取或清理用户账号缓存、官方版或原始文件。
- P04 的三个已知限制保留未解决，本步未扩大其测试结论。P06 的转换脚本、宏控制、Office 窗口保护和超时清理均未实施。

`e7f05d4015` 已按用户当次授权推送；随后用户提交并推送六项审阅修复，接续实施 P06。推送不代表真实 Office 转换已经验收。

### P01～P05 审阅修复记录（2026-10-13）

P05 完成后对 P01～P04 的四个提交做了一次代码审阅，共 10 条发现。用户确认先修前 6 条，每条一个提交；接续时核对以下修复与文档提交 `8a3a28620c` 均已在 `origin/desktop-mt`：

| 提交 | 修了什么 | 用户能看到的变化 |
| --- | --- | --- |
| `1d62f41279` | 表格解析不再因单元格中间的引号报错 | 含 `5" disk` 这类内容的 TSV／CSV 能正常显示成表格 |
| `9150677715` | 播放失败后先确认文件是否还能访问 | 音视频文件被删或连不上时提示“文件已不存在”或“无法预览”，不再一律说“格式不支持” |
| `87578c6fd4` | 注册表查询失败只丢掉 MS Office 和 WPS 候选 | PowerShell 被拦截或超时的机器上，装了 LibreOffice 仍可用于转换（转换服务 P07 才接入） |
| `5ccadec221` | 新预览复用原版的 `filePathForTarget`，路径由预览中心算一次后传给各显示器 | 只带 `file:` 地址的预览目标，新旧预览读同一个文件 |
| `60ea5e7d74` | TIFF 像素上限从 32×1024×1024 降到 20×1024×1024，去掉一份像素拷贝 | 大幅面扫描件打开时的停顿从约 2.5 秒降到约 1.3 秒；超过上限的提示“太大” |
| `69fcbbfea4` | 表格最多显示前 50 列，并提示列数被截 | 很宽的 CSV 不再卡死界面 |

需要留意的边界：

- TIFF 和表格这两条是限制上限，不是根治。TIFF 解码仍在界面线程，A3 幅面 300 dpi 的 G4 扫描件实测约 0.9 秒；表格没有做虚拟滚动。把 TIFF 解码移到后台线程后可以再放宽上限，列入 P16。
- 第 4 条改动了一处上游文件：`preview-file.tsx` 的 `filePathForTarget` 加上导出，函数内容不变，已补进 4.1 节清单。第 6 条在 i18n 各语言文件和 `types.ts` 新增一条 `preview.delimited.columnsLimited`。
- 注册表查询一直失败的机器上，每次需要转换都会重新查询一次，最长等待原有的 10 秒超时。
- 每条修复都先确认新测试在旧实现上失败、在新实现上通过。合并后 `npm run typecheck` 通过；right-rail、office-preview、i18n 三个目录共 28 个测试文件、275 项通过；改动文件 ESLint 零警告。没有启动 Electron 或操作用户窗口，真实桌面效果仍待人工验收。

审阅中尚未处理的 4 条，留到 P16 或之后：

- 探测 LibreOffice 时在主进程同步查询 PATH 中每个目录，PATH 含失效网络盘时可能卡住窗口；Linux 的候选路径偏少。
- 点刷新会重建整个预览，正在看 CSV 源码时会被带回表格视图；显示器里与刷新相关的几行代码因此不会生效。
- 含空白块的合法 TIFF 被判为不支持；带旋转标记的图片未按方向显示。
- 取扩展名的写法在仓库里有 4 份；本机文件名带 `#`（如 `report#2.csv`）时识别不出格式。

### P06 实施记录（2026-10-13）

- 动手前核对本地与远端均为 `8a3a28620c`，保留用户六项审阅修复。本步新增 `run-process.ts`、`com-scripts.ts`、`convert-com.ts` 及测试、明确选择运行的原生夹具；不修改任何上游产品文件，不新增依赖、IPC 或界面，不修改 Hermes Python 后端。
- 按真实 COM 登记选择 32／64 位系统 PowerShell，以隐藏辅助进程执行。输出限制 64 KB；转换预算预留收尾时间，默认合计不超过 180 秒的辅助进程运行预算。路径与 ProgID 通过环境变量传入，中文、空格及引号不会拼入脚本文本。
- Word、PPT、Excel 共用保护框架，只读、不显示文档窗口；打开前设置 `AutomationSecurity=3`，打开后恢复。Word／PPT 沿用 UniWork 的 PDF 格式编号，Excel 关闭链接更新、每张表缩到一页宽。文件必须为相应格式且不超过 100 MB；产物检查为普通非链接文件、非空、不超过 50 MB、具有 PDF 文件头，不把错误文本当成 PDF。
- 先保存转换前进程集合与时间，再由 COM 窗口准确绑定 PID、创建时间和实际程序路径。记录原子写入；只关闭本次文档，Word 无窗口时创建的隐藏身份探针也单独关闭。仅本次新建且没有其它文档、没有可见窗口的实例允许退出，不对用户已有 Office 调用 `Quit()`。
- 异常／超时后重新核对身份和窗口，只终止本次新建且仍准确匹配的隐藏实例。借用实例、可见窗口、身份冲突或记录不完整时不强杀。不能确认文档已关闭时返回 `cleanupSafe=false` 并保留转换目录；P07 必须据此停止后续转换、避免删除仍在使用的文件。不会按名称批量结束 Office，也不声称崩溃后一定找回所有遗留实例。
- 核对 Microsoft 文档的打开参数、宏控制与 PowerPoint 单实例行为；另只读读取本机官方 `MSPPT.OLB`，确认 Application 的 HWND 成员，没有激活 PowerPoint。WPS 的接口兼容性、Office 授权及实际 PDF 中文排版仍需人工确认。`AutomationSecurity` 不是文件安全沙箱；[Microsoft 明确说明](https://learn.microsoft.com/en-us/office/vba/api/excel.application.automationsecurity) Excel 4.0 宏不受该设置禁用，相关安全提示仍可能阻塞并超时。

定向检查与人工边界：

- `npx vitest run --project electron electron/office-preview/convert-com.test.ts electron/office-preview/com-scripts.test.ts electron/office-preview/run-process.test.ts`：3 个文件、14 项通过。PowerShell 实际执行正式生成脚本，但 COM 文档／窗口／查询对象是受控替身；检查只读参数、打开时禁宏、设置恢复、只关闭自身文档、隐藏探针及新实例退出。驱动检查使用真实临时文件和受控执行结果，覆盖超时、收尾不确定、路径、缺失／超限／伪 PDF 等。
- 辅助进程输出限制与超时实际启动独立 Node 进程；收尾检查对真实自建隐藏进程执行，确认借用进程不被终止、创建时间冲突被拒绝、准确匹配的新实例被结束。未查询或结束用户 Office。
- 受控测试先发现夹具全局变量与正式脚本重名，修正夹具；之后抓到真实的 PowerShell `.NET File.Replace` 空字符串备份路径问题，改用 `[NullString]::Value` 显式传入 .NET null 后整组通过。进程收尾测试允许多个 PowerShell 启动的合理执行时间，没有降低身份或存活断言。
- `npm run typecheck`、修改文件 ESLint 零警告、原生夹具语法、默认不启动 Office 的门控和 `git diff --check` 通过。没有运行全套桌面测试或真实 Office 夹具，不把受控 COM 检查写成真实文档转换已通过。
- 人工验收可在 `apps/desktop` 运行 `node scripts/office-preview.native.mjs --run`。它会实际启动本机 Office，生成含中文的原生 docx／pptx／xlsx 及带空格、引号的中文路径副本，用探测到的 MS Office／WPS 逐类转换；样例、PDF 和记录保留在独立临时目录。先手动打开一份 PowerPoint，再运行并确认原文档仍开着、PDF 中文排版正确。未带 `--run` 时只输出提醒、不启动 Office。
- 本步没有执行上述真实转换，也未验证用户窗口并行、真实宏文档、安装包、其它系统或 LibreOffice。英文源文件副本、账号缓存发布、候选降级、服务和 IPC 属于 P07；Word／PPT 可见预览属于后续步骤。探测的 WPS 别名与备用入口限制未改变。

本步本地提交后暂停，未推送；下一步为 P07。

### P06 首次实机验收与诊断补充（2026-10-13）

- 用户运行原生夹具后，在生成 Word 样例阶段提示无法确认安全收尾。结果目录为 `C:\Users\stan\AppData\Local\Temp\hermes-office-native-IrX2dj`；`owner.json` 没有准确 PID、`closed=false`，未生成样例或 PDF，旧夹具的 `report.json` 为空列表。因此真实转换未通过，不能把终端“请人工检查”当成成功提示。
- 只读检查发现转换开始后存在新增的隐藏 Word 进程，但仅凭时间与名称不能替代正式归属记录；没有结束任何 Office，没有操作用户窗口，没有重跑真实转换。旧脚本未保留原始异常，目前不能确定具体 COM 原因。
- 补充失败阶段、异常类型、HRESULT 和脚本行号到私有归属记录，不保存完整异常文本或文档正文。清理本身失败时明确记录 `closed=false`。没有放宽 PID／路径／创建时间／可见窗口检查，也没有增加按名称结束进程的回退。
- 原生夹具在判断成功前先保存并输出样例生成、清理与归属结果，同时写入 `sample-report.json` 和总报告；坏 JSON 或空输出不再遮住第一处失败。真实运行仍需要用户明确传入 `--run`，尚需一次新的受控人工运行取得原始错误码；本次诊断补充不等于已经修复实际 Word 转换故障。
- 同一组三个测试文件 15 项通过，新增检查实际执行受控 PowerShell 身份查询失败，核对阶段保留、禁宏设置恢复、探针关闭和不猜测进程归属。类型检查、相关 ESLint、夹具语法、默认不启动 Office 和 Git 差异检查通过；未再次激活 Office。后续先解决并复验 P06，再推进 P07。

### P06 Word 身份探针窗口修正（2026-10-13）

- 用户再次运行得到 `identity` 阶段的 COM 异常 `-2146822347`（`0x800A1735`，Word 5941，集合成员不存在），结果保留于 `C:\Users\stan\AppData\Local\Temp\hermes-office-native-5chEcm`。对应生成脚本的第 54 行创建不可见探针后读取 `probe.Windows.Item(1)`，尚未绑定 PID、尚未生成实际样例。
- 修正身份探针的窗口参数：仅在 Word 应用本来隐藏且没有文档窗口时，创建具有正常文档窗口的空白探针来取得 HWND；不设置或切换应用的 `Visible`，取得准确身份后立即关闭探针。已有文档窗口直接复用；可见但没有可绑定文档窗口的实例拒绝创建探针，避免给用户插入空白窗口。正常源文件和样例仍按原有隐藏方式打开，宏控制、只读和收尾保护不变。窗口参数与应用可见性是不同层级，参见 [Documents.Add](https://learn.microsoft.com/en-us/office/vba/api/word.documents.add) 和 [Application.Visible](https://learn.microsoft.com/en-us/office/vba/api/word.application.visible)。
- 原受控对象无论文档是否可见都返回一个窗口，遗漏了实机发现的无窗口情况。现在让夹具在不可见文档没有窗口时实际抛出同一 COM 错误：两个定向用例先在旧实现失败，修正后通过。整组三个文件 16 项通过，覆盖探针关闭、新空实例退出、应用保持隐藏、可见空实例不新增窗口和原有身份保护。类型检查、相关 ESLint 和 Git 差异检查通过。
- 本轮没有启动真实 Office 或处理之前的遗留进程。以上属于取窗逻辑修正与受控回归，真实 MS Office／WPS 转换、中文排版和已打开文档保留仍待用户重新运行原生夹具确认，不能将其记为端到端已经通过。

### P06 未登记实例退出、WPS 转换与收尾耗时修复（2026-10-13）

- 用户后续实机运行已取得 MS Office 的三类 PDF，但 WPS 三类不可用，并发现五个遗留 Word PID。此前退出依赖已登记 PID，身份或安全设置阶段失败时会遗漏刚返回的独立 COM 对象。本次对空、隐藏、非用户控制的独立 MS Word／Excel，直接通过本人对象退出，不猜测 PID；此退出与设置恢复分开执行，恢复失败也会尝试。共享 PowerPoint／WPS、可见或存在其它文档的对象不走此路径。激活没有返回对象、对象信息不可读、进程或文件记录不可信时仍不能保证自动清理，不按名称强杀。
- 按用户指定 PID 逐个核对程序全路径、完整自动化命令行、创建时间及无可见窗口：13212 已不存在，28676、13140、31852、32720 已结束。没有删除历史、文档或转换目录；未触碰原有 WPS 进程。真实转换结束后复查没有新增 Word／PowerPoint／Excel／WPS 演示残留。
- WPS 优先使用 KWPS／KWPP／KWET／KET 等专用入口，补齐主要 `.6` 别名，避免与 MS Office 共用通用 CLSID 时激活错误软件。同厂家仍只选择一个候选，不宣称所有版本别名或备用入口已覆盖。
- 实际组件必须位于登记的同一安装目录：WPS 演示允许 wps.exe／wpp.exe，表格允许 wps.exe／et.exe；不接受其它目录。通过 [QueryFullProcessImageNameW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew) 查询实际路径并展开短路径，不依赖可能受位数限制的 Get-Process.Path。路径冲突先保留诊断再拒绝，不调用错误应用的 Quit。
- 本机 WPS 12.1.0.29161 的演示 COM 不实现应用／文档 HWND，标准 IOleWindow 也不可用。该分支只关闭本次文档、释放 COM，不创建额外身份文档、不退出或强杀共享 WPS。收尾须同时确认对象关闭和本次新增相关进程已消失；未登记且仍有新进程、文档未确认关闭或超时，返回 cleanupSafe=false，停止后续降级。此保护并不保证无窗口 WPS 在任意崩溃后可自动找回归属。
- 显式释放窗口、文档集合及样例的范围／单元格等引用。已准确登记的新建空实例，在二次核对 PID、创建时间、路径和不可见后先结束，再释放客户端引用，避免已关闭 PowerPoint 的远端 COM Release 长时间等待；借用实例只释放自身引用。夹具增加生成、收尾和转换计时，成功结果不再附带失败 code。
- 用户授权的一轮原生转换和失败项定向复测，使用独立临时中文／空格／引号路径，不操作用户文档窗口。MS Office 的 docx／pptx／xlsx 与 WPS 的 docx／pptx／xlsx 均取得真实 PDF；WPS PPT 是修正无 HWND 分支后单独通过，不把最初整轮报告中的失败改写成通过。报告及样例位于 `C:\Users\stan\AppData\Local\Temp\hermes-office-native-TPrUSU`，PPT 复测见 `retest-report.json`。单次 MS PPT 转换约 25.18 秒降至 6.54 秒，WPS PPT 最后约 5.56 秒；这是不同轮次的单次观测，不是严格性能基准，未用最终代码重跑全部六项计时。
- 最终定向命令：`npx vitest run --project electron electron/office-preview/detect.test.ts electron/office-preview/convert-com.test.ts electron/office-preview/com-scripts.test.ts electron/office-preview/run-process.test.ts`，4 文件 38 项通过。覆盖登记前失败、设置恢复再次失败、共享实例保护、无 HWND 的自有／借用 WPS 文档、路径冲突、32 位辅助进程读取 64 位路径、未登记关闭确认及真实自建进程的创建时间复核。TypeScript、相关 ESLint、夹具语法、默认不启动 Office 的门控和 Git 差异检查通过。
- PDF 文件头和真实转换成功不等于中文视觉排版验收；用户已有 Word／PPT／Excel 文档并行、真实宏文件、Office 授权异常、安装包、其它系统和 LibreOffice 仍待验证。本次不修改 Hermes Python 后端或上游产品文件；按要求将本次修复写入一个本地提交，不推送，不进入 P07。

### P07 本机转换服务与桌面接线（2026-10-14）

- 接续时本地与远端均为 `6f3c7cc558`。核对此前之后的 MCP、工作目录、微信及登录样式提交，未修改已有预览模块；只在当前 preload 上新增一个方法，没有覆盖协作者的 MCP 密钥处理。P06 四个提交此前已推送，最新为 `7bf5fe50b3`。不修改 Hermes Python 后端、官方对照版、用户数据或本机计时文件。
- 新增 `convert-libreoffice.ts`、`service.ts`、`ipc.ts`。正式服务串起读文件校验、真实路径与版本键、缓存、全进程单队列、英文名副本及 MS Office → WPS → LibreOffice 降级。排队后和复制后复核源版本；不同厂家使用不同产物目录，坏 PDF 不会被后续转换误当成成功。源文件 100 MB、PDF 50 MB；检查普通文件、非符号链接、非空和 PDF 文件头。
- 同账号同版本的并发请求共用一次转换，后续读取直接命中账号缓存；不同账号不共用缓存。软件不可用时使探测缓存失效，下一次请求重新探测，不在本轮无限重试。各转换器共享 180 秒剩余执行预算，不为每家重新分配完整预算；源文件读写和排队等待不提供硬实时保证。全部失败保留实际转换失败／太大／超时等原因，不让末尾的不可用覆盖前面的实际错误。
- 继续遵守 P06 的 cleanupSafe 约定：不安全立即停止降级，保留该次源副本、配置和归属记录。为受管临时目录增加 `retain` 标记，普通的一小时残留回收跳过它，避免服务重建后丢失排障证据；该目录须人工确认后处理，本步不实现自动恢复或按名称清进程。
- LibreOffice 使用独立配置和最高宏安全级别，不借用用户配置；不经过 shell。Windows 使用同安装目录的 soffice.com 控制台入口，不回退到可能提前返回的 GUI 启动器，参数依据 [LibreOffice 官方说明](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)。正常结束或未能启动时回收配置；超时／异常终止无法确认后代状态时保留现场并报告不安全，不把辅助程序退出当成所有后代都已结束。本机没有 LibreOffice，实际软件、宏策略及其它系统未验证。
- 实际改动的上游产品文件仅 `electron/main.ts`（导入与注册）、`electron/preload.ts`（单一方法）和 `src/global.d.ts`（返回类型）。缓存固定来自主进程账号上下文，页面只提供文件路径，不提供账号、缓存目录、程序或凭据。新增 IPC 校验桌面窗口、主框架、固定页面、账号分区和当前上下文；等候时账号退出或页面跳转后不返回 PDF，账号撤销后不再启动等待中的转换。已有执行中的转换不因页面离开而取消。
- 新增接口为 `window.hermesDesktop.convertOfficePreview(文件绝对路径)`：成功仅返回 `ok/pdf/version/converter`，PDF 为 Uint8Array；失败只返回 `ok/code`，不传内部异常、缓存路径或进程信息。重启源码开发版后可在自己的开发者工具调用；本步没有 Word／PPT／Excel 查看器，不会改变当前预览面板。P08 再接 Word 的可见预览。
- 定向检查：`npx vitest run --project electron electron/office-preview`，9 文件 60 项通过；随后修改到的服务、LibreOffice、IPC 和缓存四文件 19 项复测通过。检查顺序、降级、总预算、原文件保留、伪／超限／缺失 PDF、缓存复用、A→B→A 账号缓存、退出时的队列限制及 retain 回收保护。类型检查最初发现 LibreOffice 测试替身误用了 COM 参数类型，已修正；ESLint 格式警告已按仓库规则处理。最终 `npm run typecheck`、改动文件 ESLint 零警告、夹具语法与 `git diff --check` 通过。
- `node scripts/office-service.native.mjs`：1 项隐藏独立 Electron 检查通过，经过正式 Renderer／preload／IPC、文件复制与缓存，第二次调用不重复转换，返回真实跨 IPC 的 Uint8Array。仅软件转换器使用受控产物，没有启动 Office、MaaS、Hermes 后端或用户窗口；这不是 P07 真实软件全链路验收。夹具记录位于 `C:\Users\stan\AppData\Local\Temp\hermes-office-service-native-xJQkXu`。本轮不重跑 P06 Office 实机轮次、不验证中文排版、安装包、已有文档并行或云端。
- 本步按约定本地提交后暂停，不推送，不进入 P08；真实查看器验收继续交由用户。

### P08 Word 转 PDF 预览（2026-10-14）

- 接续 HEAD 为 `26bcd424a6`，远端仍为 `6f3c7cc558`；P07 是已完成但尚未推送的本地提交，不需要拉取或覆盖。保留用户本机计时内容。本步不修改主进程、Hermes Python 后端、官方对照版或用户文件，不安装新依赖。
- 在预览中心登记共享约定中的 docx／doc／odt，懒加载新的 `office-pdf-preview.tsx`。`source.ts` 是唯一的连接判断处：本机调用 P07 的 `convertOfficePreview`，远程直接报告不可用，不把远程路径送到本机软件。连接变化后不再返回旧 PDF。Word 前端直接渲染兜底仍属于 P09；PPT、Excel 尚未登记。
- 使用已有 PageLoader 和本地化首次转换说明；PDF 字节转成 application/pdf Blob，以 Chromium 原生 iframe 阅读器显示，不把 Office 源文件或 data URL 当成 PDF。关闭、换文件和刷新时撤销旧 Blob 地址；忽略迟到的转换结果，页面离开不取消主进程已经执行的任务。沿用 PreviewPane 已有的文件监视及 reloadKey，没有另建文件监听或前端缓存；版本与转换缓存仍由 P07 管理。
- 失败原因与共享转换约定对齐，新增超时、转换失败说明；所有错误经过预览中心保留原文件出口。本机 Word 不可用时说明可安装 LibreOffice；远程只保留原连接、Profile 的下载，不提示安装本机软件。补齐全部九种语言与类型定义，不改现有 CSV／TIFF／音视频、文本、HTML、PDF 的入口或源文件逻辑。
- 按 [iframe 的事件说明](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#error_and_load_event_behavior)，浏览器不会可靠地用 error／load 区分内容是否成功显示。本步复用原有 PDF 阅读器，不保留无效的 iframe error 回调，不将 iframe 挂载当成 PDF 排版或解析已经验收。转换错误和 Blob 创建失败可回到正式失败流程，阅读器内部解析或排版仍需实机确认。
- 新组件先因尚未实现而测试失败，再接入并验证。四个定向文件（office-pdf-preview、format-preview、source、catalog-completeness）64 项通过，覆盖三类 Word 登记、加载说明、PDF MIME／字节、刷新与释放、换文件和连接后的迟到结果、六种错误、安装提示、远程不调用本机转换及归属正确的下载。原有 preview-file／preview-pane 两文件 33 项回归通过；合计六文件 97 项。完整 `npm run typecheck`、改动文件 ESLint 零警告和 `git diff --check` 通过。早期夹具曾试图触发 iframe error，核对浏览器行为后删除无效产品回调，改为真正能发生的 Blob 创建失败检查，转换失败的断言继续保留。
- 按用户要求不重复原生 Office 或整套 Electron 验收。本轮组件调用的转换接口返回受控字节，jsdom 不渲染真实 PDF；未重新证明 P06 的真实转换，也未验证真实桌面 Word 排版、缓存打开速度、磁盘保存事件、安装包或云端。不能把上述自动检查写成“真实 Word 端到端已通过”。
- 人工验收：重启源码开发版，在文件树或聊天文件卡片打开 docx／doc／odt，检查首次说明、中文排版及 PDF 滚动；关闭后再次打开观察缓存效果；修改并保存原文档后确认预览刷新；再核对普通 HTML、PDF、文本和音视频仍正常。首次调用会使用本机转换软件，已有 Office 文档不要关闭，顺便确认其仍保留。P09 完成前，没有转换软件或远程 Word 只显示原因及原文件出口。
- 本步本地提交后暂停，不推送，不进入 P09。

### P09 Word 前端渲染兜底（2026-10-14）

- 按用户当次授权将 P07、P08 推送到 `origin/desktop-mt`，远端核对为 `6811e87775`。本步继续已批准的实施计划，不修改 Hermes Python 后端、官方版或用户文件。
- 查阅 UniWork 的 `DocxViewer.tsx` 和 [docx-preview 官方接口](https://github.com/VolodymyrBaydalka/docxjs#api)，新增精确依赖 `docx-preview@0.4.1`。npm 元数据确认发布于 2026-09-21，满足十四天规则。库按需懒加载；JSZip 是该库自己的间接依赖，不新增直接 JSZip 依赖或解压实现。
- Word 登记顺序仍为本机转 PDF → docx 前端渲染；候选筛选集中在 registry，只让 docx 使用第二项。doc／odt 不交给错误的解析器，保留原转换失败和文件出口；文件不存在时仍直接停止。源字节复用 `source.ts` 和既有读文件限制，远程使用原连接和 Profile 的鉴权接口，不送到本机 Office。本步没有增加云端转换接口。
- 新阅读器保留文档分页、表格和内嵌内容，视口按最宽页面及面板宽度缩小，不重排原有页面。面板变宽后恢复原尺寸，不额外放大；缩放包含原生滚动条。刷新重新解析，离开或换文件后忽略迟到结果并解除尺寸监听；base64 内嵌资源随组件释放，不产生需要回收的文档 Blob 地址。
- 不把文档 CSS 注入应用页面。复用现有 DOMPurify 清理生成内容并保留必要排版样式，移除链接跳转、禁用 altChunk HTML；在空 sandbox 的独立 iframe 显示。内容策略只允许内联样式及 data 图片／字体，不允许脚本、外部资源、表单或基址覆盖，iframe 不获得 preload、同源访问或弹窗权限。参考实现直接注入页面的方式没有照搬。
- 定向命令：`npx vitest run --project ui src/app/chat/right-rail/formats/docx-preview.test.tsx src/app/chat/right-rail/formats/office-pdf-preview.test.tsx src/app/chat/right-rail/formats/format-preview.test.tsx`，最终三文件 44 项通过，其中新文件 13 项。真实生成 OOXML 压缩包并调用正式解析库，覆盖中文、表格、分页、样式保留、链接清理、altChunk 禁止、PDF 优先、转换失败降级、远程归属、读取错误、损坏文件、刷新及迟到结果。面板尺寸通知受控，jsdom 不做真实排版。原 PDF 失败说明检查改用没有前端候选的 doc／odt，继续检查原错误和出口，并未降低新 docx 的降级断言。
- 完整 `npm run typecheck`、改动文件 ESLint 零警告、`git diff --check` 通过。未重复原生 Electron／Office 夹具，不发送短信、不调用模型，不把组件检查写成视觉验收。中文分页、图片／字体、滚动条缩放手感、复杂文档、安装包和真实远程环境待人工核验。
- 人工检查兜底时，可在自己的开发环境临时将 registry 的 Word 候选调为前端优先，再打开 docx，检查中文、表格、分页、窄面板与宽面板，保存原文件后检查刷新；检查完恢复 PDF 优先。此临时顺序不是提交内容，也不新增常驻调试开关。本步使用上述受控转换失败检查正式顺序，没有操作用户窗口。
- 本步本地提交后暂停，未推送，不进入 P10。实际改动的上游文件只有桌面 `package.json` 和根 `package-lock.json`；其余产品改动在已有预览中心及新增阅读器内，没有改变原版 PDF／HTML／文本或音视频入口。

### P10 PDF 逐页渲染（2026-10-14）

- 按用户当次授权推送 P09，核对远端为 `1766d565ef`。本步新增 `pdf-pages.ts` 供 P11 使用，不登记 PPT，不改现有 Word／PDF 阅读器，不修改 Hermes 后端、官方版或用户数据。
- npm 元数据表明最新版 `6.4.299` 发布于 2026-10-03，尚未满十四天，因此精确安装 `pdfjs-dist@6.3.289`。查阅官方接口及包内类型，不采用已删除的旧参数。常规构建在当前 Electron 真实执行时缺少 `Map.getOrInsertComputed`，改用包内官方提供的 legacy 主模块和对应 Worker，没有自写 polyfill 或静默切到主线程。该构建选择符合包内 README 对环境支持的说明。
- 接口提供 `pages` 尺寸列表、从 1 开始的 `renderPage(页码)` 和幂等 `dispose()`。原 PDF 字节先复制，避免 Worker 转移所有权使调用方数据失效。每张图长边 1600 像素，每份文档串行绘制，同页并发共用一次任务；最近六页保留 PNG 地址，命中更新使用顺序，淘汰时撤销旧地址。每次绘制或失败都清空画布并清理页面，失败不阻塞后页。关闭时撤销缓存、终止 Worker、禁止排队任务继续，并等候正在编码的页面归还资源；调用方不能继续使用被淘汰的图片地址。
- 为落实离线资源要求，补充计划最初清单之外的必要构建接线：新增 `pdf-assets.ts`，在 `vite.config.ts` 导入并注册，共 3 行。开发服务器只提供已登记的 CMap、标准字体、WASM、ICC 文件，不能通过 URL 读取任意磁盘路径；生产构建将同一份文件及许可证写入相对目录。Worker 使用 Vite 的本地资源导入，辅助资源基于页面地址定位，不使用 CDN。本步没有修改其它构建策略，已同步 4.1 文件清单。
- 六项定向检查覆盖原字节与尺寸、长边限制、同页合并、LRU、画布释放、失败后续、非法页码、空编码、关闭期间迟到结果、排队限制及重复关闭。最后与 P09 新阅读器共同运行：`npx vitest run --project ui src/app/chat/right-rail/formats/pdf-pages.test.ts src/app/chat/right-rail/formats/docx-preview.test.tsx`，两文件 19 项通过。缓存／收尾使用受控 PDF.js 对象，不将其写成真实解析证明。
- `scripts/pdf-pages.native.mjs` 只接受现成 PDF，不启动 Office，未传参数时只显示用法。复用 `hermes-office-service-real-df63158d/pdf/ms-office/slides.pdf` 与 `pdf/wps/slides.pdf`；对应旧报告确认两者来自本机真实软件。本轮没有再次执行转换，也没有操作任何用户窗口。
- 最终原生夹具 1 组通过，实际覆盖开发 HTTP 与生产 file 两种模式 × 两厂家样例。经过正式 Vite 配置及正式模块，每份 PDF 启动真实 Worker，不接受 fake worker；每页取得 1600×900 PNG，关闭后检查 Worker 消失。两种模式均读取 CMap／字体／WASM／ICC，比较文件长度和文件头，防止把 404 HTML 当资源成功；外部网络请求被阻断。该检查验证生产构建文件可读，不等于安装包已经验收，也未证明每一种图片解码器。
- 依照 PDF 技能，用 Poppler 分别渲染两份源文件作为参考，逐一查看开发与生产的四张实际 PNG，中文均可读、未见缺字乱码，因此不启用方案 B。源样例各只有一页，不能外推为复杂字体、全部文字、30 页长文档或其它系统都已验证；这些继续由后续真实验收覆盖。PDF.js 留有 `TT: undefined function: 3` 字体提示，已保留在报告；本次图像对照没有观察到对应缺字，不把它写成零运行警告。
- 夹具早期暴露常规构建不适配当前 Electron；另曾因开发页热更新失去句柄，隐藏窗截图也不能代表实际编码图像。最终关闭夹具热更新，直接保存正式图片地址的 PNG 字节。临时入口的资源基址曾指向 `/@fs` 下的测试目录，现显式对齐正式开发页根地址，严格资源内容断言保留。失败轮次记录不覆盖；最终报告与四张图片保留在 `C:\Users\stan\AppData\Local\Temp\hermes-pdf-pages-hzG5pY`。
- 完整 `npm run typecheck`、新增资源插件独立 TypeScript、改动 TS 文件 ESLint 零警告、原生脚本语法及 `git diff --check` 通过。Vite 仍有已有的 advancedChunks 弃用提示。未制作安装包，未跑整套桌面测试，未验证 PPT 滚动／全屏界面、真实云端或新一轮 Office 收尾。
- `995d7f1de3` 已按用户当次“推送，继续”授权推送；随后开始 P11 接入幻灯片查看器。

### P11 实施记录（2026-10-14）

- 在预览中心登记 `.pptx`、`.ppt`、`.odp`，共用已有 Office 扩展名约定、转换 IPC 与 `source.ts`，首次打开时才懒加载查看器。没有新增依赖、转换进程、文件读取权限或后端接口。
- 普通模式按各页比例占位，页面进入滚动容器附近才通过 P10 绘图，离开后卸载图片；页码取可见部分最多的一页，平局取前页，滚到底取末页。图片持有自己的 Blob 地址，避免底层六页缓存淘汰使仍可见图片失效；卸载时释放。
- 全屏从当前页开始，一次显示一页；支持前后按钮、方向键、空格／Shift+空格、PageUp／PageDown、Home／End 和 Escape，限制页码范围，不截获带 Ctrl／Meta／Alt 的组合键或按钮自己的 Space。退出全屏回到放映结束页。全屏权限失败保留普通预览，给简短说明。
- 换文件、刷新或关闭后收尾解析器、Worker 和图片地址；迟到的转换或解析结果不能接管新文件。转换／绘图失败走统一说明页，本机给文件夹出口，不可用时提示安装 LibreOffice；远程不调用本机 Office，保留原连接和 Profile 的下载出口。
- 控件复用桌面现有 Button／Tip、加载器和主题令牌，补齐九种语言。仅参考 Web 的 PPT 交互，没有整体合并该分支，也没有修改普通 PDF、Word、Hermes Python 后端、登录或账号管理。
- 本步新增 10 项组件检查，连同预览中心和翻译完整性检查，三个文件共 48 项通过。32 页来源、转换结果、图片编码、全屏权限和几何均受控；这不是实际 32 页 PPT 转换或系统全屏的证明。
- 完整 `npm run typecheck`、改动文件 ESLint 零警告及 `git diff --check` 通过；没有执行全量桌面测试或制作安装包。
- 测试初期卡在对 DOM 节点做深比较：节点带有 React 循环引用。改为校验滚动容器的同一对象与订阅参数后整组通过，未通过删除功能断言来绕过失败。
- 按用户要求不再搭建或重复运行原生 Office／Electron 夹具。人工核验：重新启动开发版，从文件树打开 30 页以上 PPT；检查快速滚动、页码、全屏翻页、Escape 返回位置、调整面板大小及关闭／刷新。中文排版、真实 Office 转换、已有文档并行、系统全屏、安装包和其它系统仍待验收。

`3d6e991adf` 已按用户当次授权推送，随后开始 P12。

### P12 实施记录（2026-10-14）

- 重新核对本地与远端均为 `3d6e991adf`，无需同步；参考本机 `source.new-uniclaw @ 8ae3548e` 中的 `FortuneXlsxViewer.tsx`、`xlsxPreviewModel.ts` 和 `fortuneWorkbookModel.ts`，只移植基础展示与尺寸通知，不带入旧表格兜底、外部文件获取、图表库或整套 XML 样式处理。
- 依赖固定为 FortuneSheet 两包 `1.0.4` 和官方 CDN 的 SheetJS `0.20.3`。npm 元数据确认 FortuneSheet 发布于 2025-11-06，peer 支持 React >=18.2；[SheetJS 官方 tag](https://git.sheetjs.com/sheetjs/sheetjs/src/tag/v0.20.3) 对应 2024-07-12，满足发布满 14 天规则。[官方安装说明](https://docs.sheetjs.com/docs/getting-started/installation/frameworks/) 确认使用固定 CDN 包地址，实际安装成功并保留锁文件完整性摘要。没有使用 npm 的旧版 0.18.5，也没有新增 JSZip、图表或 Office 依赖。
- 接线前完成正式 Vite 生产配置与独立隐藏 Electron 窗口的兼容性检查，真实 React 19 画布、切表与窗口尺寸变化通过。当前构建无需 UniWork 的 uuid 覆盖，因此未改根 `package.json`；npm 留有 FortuneSheet 传递依赖 `uuid@8.3.2` 的弃用提醒，不把安装结果写成零警告。
- `.xlsx`、`.xls`、`.ods` 通过预览中心懒加载，直接复用 `source.ts` 的原有受限本机／远程读取和大小限制。解析失败或组件异常依次尝试现有 Office 转 PDF；明确文件不存在时停止降级；远程失败保留原连接与 Profile 的下载出口，不在本机启动 Office。普通 PDF 和 Word 显示方式未改。
- 模型保留原行列坐标、缓存值与显示文本、日期和数字格式、合并、行高列宽及隐藏行列。每表最多 500 行，跨边界合并裁到实际显示范围；有截断时显示九种语言的提示。优先用文件内的磅数换算行高，避免库生成的像素字段未经 DPI 换算而压矮行。输入先转为当前环境的字节视图，避免跨环境 ArrayBuffer 被库误判成文本表格。
- 表格只读，不传宏、公式、外部链接或绘图给组件执行；公式仅显示原文件已保存的结果，不重新计算。保留轻量尾部网格；单表和工作簿累计网格、合并展开最多 250000 格，避免小文件用巨大维度触发内存分配。没有截掉列来冒充完整预览，资源超限走 PDF 候选。
- 复用 UniWork 的按帧 ResizeObserver 通知，拖动预览分隔条时触发库已有的布局重算；卸载时解除监听。表格内部使用库已支持的简／繁中文、英文、西语和俄语；其它应用语言由该库回落到英文，外层提示仍覆盖全部九种语言。颜色、字体、边框、图片和图表还未实施，分别属于 P13～P15。
- 四个文件 54 项定向检查通过：真实 SheetJS 三格式往返、1900／1904 日期、原坐标、缓存公式值、合并与裁剪、尺寸和隐藏行列、资源上限、正式入口、迟到结果与刷新、只读参数、降级、远程归属和翻译完整性。组件测试仅替换画布；读取封装和解析实际执行，底层 IPC／远程响应受控。首轮暴露的跨环境字节误判与行高换算已修正；测试的生成 API、缺失文案和语言 Provider 配置也已对齐正式契约，没有降低产品断言。
- 原生检查：`node scripts/sheet-preview.native.mjs --run` 最终一组通过。独立生产入口使用正式显示器、读取封装和解析器；三种真实格式各有两表、503 行，核对真实 Canvas 绘制文字、切表、500 行说明、面板改变尺寸，以及双击／F2／输入／Enter 后重绘仍保留原内容。文件读取桥接返回夹具字节，未使用用户数据；没有启动 Hermes、Office、MaaS 或付费模型，没有操作用户正在使用的窗口。
- 全局样式既有的 Courier Prime 网络字体在夹具中被阻断，其余外部请求为空。早期夹具的临时目录依赖解析问题已修正；只读检查也从错误的“不得存在 contenteditable 节点”改为实际输入与重绘检查，因为库保留了辅助编辑节点。正式构建仍有已有的分块弃用和动态导入提示。成功样例及报告：`C:\Users\stan\AppData\Local\Temp\hermes-sheet-preview-v3ZtHx`，含 `中文样例.xlsx`、`.xls`、`.ods`。
- 完整 `npm run typecheck`、改动文件 ESLint 零警告、原生脚本语法和 `git diff --check` 通过。未运行整套桌面测试、真实 Office 转换或打包。真实账号桌面排版、用户复杂文件、复制行为、其它系统和安装包仍待验收；P13～P15 尚未开始。

`89380bba58` 已按用户当次“推送，继续”授权推送，随后开始 P13。

### P13 实施记录（2026-10-15）

- 参考同一本机 UniWork 的样式模型和 FortuneSheet 适配，补读 XLSX 的主题与样式 XML；复用既有 `fflate` 和共享 RGB 工具，不增加依赖，不修改 Hermes 后端、主进程、账号逻辑、官方版或用户文件。本步产品改动只在预览中心，未改动上游原有文件。
- 按工作簿关系定位工作表、主题和样式部件，不猜测 sheet 编号或 XML 前缀。恢复 RGB／主题／索引颜色、HSL 明暗调整、字体与字号、粗斜体、下划线、删除线、实色填充、四边框、水平／垂直对齐及换行。主题的颜色编号按固定语义读取，不按节点出现顺序；基础格式继承和显式关闭均单独处理。
- 空白但带样式的单元格仍保留。合并格的边线转为整个区域的边线，硬换行使用组件已有的内联文本布局。FortuneSheet 只接受单个字体名，因此选择文档指定字体或主题首个有效字体，缺字沿用组件已有后备字体，不把 CSS 字体列表当成一个不存在的字体。
- 只将 XML 当作数据，不执行公式、宏、链接或外部资源。拒绝 DTD、损坏 XML；本步解压的 `xl` XML／关系累计上限为 16 MiB，最多收集前 500 行内的 250000 个单元格。超限或解析失败仍走现有失败与 PDF 候选链，不静默伪装为样式完整的简化表。
- 样式增强仅针对 XLSX；XLS／ODS 保留 P12 基础预览。条件格式、渐变／图案填充、富文本局部字体、旋转、行列默认样式及精确打印排版不在本步完整还原范围；图片和图表仍属于 P14／P15。没有字体下载、编辑或样式写回。
- 五个相关文件共 60 项检查通过，其中新增 6 项样式检查，实际生成并解析 XLSX，覆盖改名部件、主题顺序、明暗与 SheetJS 独立解析结果、索引色、格式继承、显式关闭、空白格、前缀、坏 XML 和资源上限。最终适配调整后，样式与基础模型两文件 13 项再次通过；未运行全量桌面套件。
- 复用 `node scripts/sheet-preview.native.mjs --run`，最终 1 组通过。正式生产入口在隐藏独立 Electron 中实际绘制 XLSX／XLS／ODS，核对切表、只读、行数提示、尺寸调整，并记录 XLSX 的真实字体、背景、边框和中文分行坐标。初轮样例缺少完整主题格式块，已修正；画布检查进一步修正了单字体、硬换行和合并格边线适配，未用放宽断言替代修复。
- 已查看最终实际 Canvas PNG，样例中文、换行、背景和边框可见。样例与报告保留在 `C:\Users\stan\AppData\Local\Temp\hermes-sheet-preview-gGIXvn`，包含三种格式、`styled-canvas.png` 和 `report.json`。文件读取桥接返回真实夹具字节，不是当前用户后端；既有全局 Courier Prime 网络字体仍被阻断，其它外部请求和页面错误为空。Vite 留有既有的分块弃用及动态导入提示。
- 完整 `npm run typecheck`、改动 TS 文件 ESLint 零警告、原生脚本语法和 `git diff --check` 通过。本轮没有启动 Office、MaaS 或 Hermes，没有制作安装包，没有与 Excel 实机对照，不将夹具通过写成用户复杂文件验收通过。
- 人工验收：重启开发版，打开上述 XLSX 样例或自己的带样式文件，对照 Excel 检查中文字体、色彩、合并格边框和对齐；拖动预览面板并切表，修改源文件保存后检查刷新。精确字体、复杂文件、真实远程、其它系统及安装包仍待核验。本步本地提交后暂停，未推送，不进入 P14。

`c00583593c` 已按用户当次“推送，继续”授权推送，随后开始 P14。

### P14 实施记录（2026-10-15）

- 参考同一本机 UniWork 的绘图关系、锚点及裁剪处理，新增图片解析与 FortuneSheet 图片适配，不增加依赖。P13 的 ZIP、XML 和关系读取提取成样式与图片共用的 `package.ts`，每份工作簿只解压一次、同一 XML 只解析一次，没有保留旧接口或重复解析实现。
- XLSX 支持包内 PNG／JPEG／GIF／WebP／BMP，按工作表→绘图→媒体关系定位，不依赖固定编号或 XML 前缀。支持单格、双格和绝对锚点；EMU 换算为像素，保留偏移，并扣除隐藏行列。普通图片直接使用位图；裁剪、旋转或翻转时用自行生成的 SVG 容器，只在内部嵌入受限的位图 Data URL，不插入源文件自带的 SVG／HTML。
- 图片起点在第 500 行之后或完全超出显示区域时不显示；图片位置不会扩大单元格网格。外链图片不请求、不代理到本机。缺失、不支持的内嵌图片、坏绘图 XML、无效位置或裁剪会交给原有失败和 PDF 候选链；组件挂载前实际解码位图，失败不能用空白图片冒充成功。换文件和卸载后忽略迟到结果。
- XML 展开仍限 16 MiB；媒体展开及按引用累计图片字节各限 32 MiB，每份最多 64 张图片；位图解码后累计最多 32 Mi 像素，单张显示区域最多 16 Mi 像素、长边最多 32768。解码像素限制在浏览器解码后检查，不宣称能在解码前阻止一切恶意图片内存开销。图片内容只在当前预览内存中使用，没有新缓存、账号共享或磁盘写回。
- 实机发现 FortuneSheet 的 `allowEdit=false` 不阻止点击图片进入编辑状态，已在预览组件捕获图片区域的鼠标、上下文菜单和键盘编辑事件，Tab 仍可离开。普通单元格、滚动和切表不受影响。没有修改库、后端或新增通用全局事件拦截。
- 五文件 46 项定向检查通过，其中新增 5 项图片解析／适配检查和 1 项正式入口解码失败降级检查。实际生成带媒体关系的 XLSX，覆盖三种锚点、隐藏行列、裁剪、翻转、外链拒绝、缺失／不支持图片、资源上限、解码失败和原样式回归。组件解码失败使用受控对象，不能算真实图片解码证明。
- 复用 `node scripts/sheet-preview.native.mjs --run`，最终 1 组通过。生产入口在隐藏独立 Electron 中实际解码和挂载三张图片，读取裁剪、原图与翻转后的像素，核对尺寸；实际点击图片不再进入编辑状态，随后完成三格式只读、切表和面板调整检查。已查看真实 DOM 图片经 Canvas 导出的三张 PNG，夹具不读取用户文件，也不启动 Hermes、Office、MaaS 或模型。
- 最终文件与报告位于 `C:\Users\stan\AppData\Local\Temp\hermes-sheet-preview-k4rlry`，含 `中文样例.xlsx`、基础 XLS／ODS、`picture-1.png`～`picture-3.png` 和 `report.json`。早期窗口截图等待隐藏窗口合成而超时，改为导出实际图片节点的像素，不把隐藏窗口截图当作排版证据。既有全局网络字体仍被阻断，其它外部请求和页面错误为空；Vite 仍有既有分块弃用和动态导入提示。
- 完整 `npm run typecheck`、改动 TS 文件 ESLint 零警告、原生脚本语法及 `git diff --check` 通过。没有运行整套桌面测试、Office 转换、安装包或真实远程环境。旋转、垂直翻转及 PNG 以外的编码已接线但未逐种实机验收；组合图形、浮动文字、背景效果、EMF／WMF 和文件自带 SVG 不承诺还原，图表留给 P15。XLS／ODS 图片不在本步实现。
- 人工验收：重启开发版打开上述 XLSX，表格右侧应出现裁剪后蓝色、原图左红右蓝、水平翻转左蓝右红三张示例；再用自己的文件对照 Excel 检查位置、裁剪、隐藏行列、滚动、切表及保存后刷新。本步本地提交后暂停，未推送，不进入 P15；所有产品改动均位于预览中心，没有修改上游原有文件、Hermes Python 核心、官方版或用户数据。

`6d32b6b33b` 已按用户当次“推送，继续”授权推送，随后开始 P15。

### P15 实施记录（2026-10-15）

- 为遵守单次业务改动行数约束，拆为两个完整本地提交：`76b19f4e28` 先整理共用绘图读取和定位，原图片功能直接使用；随后接入图表解析与渲染。没有留下未消费接口，也没有复制另一套 ZIP、关系或几何处理。
- 参考同一本机 UniWork 的图表解析和图表转图片方式，核对 [ECharts 按需导入](https://echarts.apache.org/handbook/en/basics/import/) 与 [SVG 字符串渲染接口](https://echarts.apache.org/handbook/en/how-to/cross-platform/server/)。精确安装 `echarts@6.1.0`；npm 元数据确认发布于 2026-05-19，满足十四天规则。仅增加该包及其锁定依赖，没有覆盖既有库版本。实际改动的上游文件仅 `apps/desktop/package.json` 与根 `package-lock.json`。
- XLSX 沿真实关系读取常见二维柱状、折线、饼、环形、面积和散点图；支持中文标题、系列、类别、图例、横向、堆积／百分比堆积、平滑线、数据标签及基本轴范围／方向。缓存按索引保留缺失位置，空数值不变成零；没有缓存时，只从当前工作簿前 500 行的单元格缓存值读取普通区域引用，不执行公式、不刷新外部数据。没有类别缓存时不承诺完整类别恢复，多层类别、日期轴和特殊数字格式尚不完整。
- 组合、三维、未知类型、坏 XML、缺失或外部图表关系交给现有失败与 PDF 候选，不静默改成另一类图。不同系列类别不一致时也明确失败，避免错位。每份工作簿最多 32 张图，每图最多 64 系列，单组缓存最多 10000 点、类别和数值累计最多 20000 点；引用只访问本包，沿用 XML、网格及绘图尺寸上限。
- 只有实际包含图表时才动态加载独立绘制模块；使用 `echarts/core`、四类系列、标题／图例／网格和 SVG 渲染器，不引入整包全部图表。通过官方 `ssr: true` 和 `renderToSVGString()` 在 Renderer 中生成静态图片，不是新增服务器渲染服务。每次生成后在 finally 中销毁实例，关闭或换文件不接纳迟到结果；复用已有图片解码、位置及只读边界，不创建常驻图表实例、磁盘缓存或新 IPC。
- 图表只传入自建的受限选项，标题是文字，不接收文件中的函数、HTML、链接或任意 ECharts 配置；禁用动画、工具提示和图内交互。图片随预览内容重新解析、随布局显示，不支持编辑或写回。使用固定文档配色与基本布局，不承诺精确复制 Excel 主题、背景、字体、打印和绘图层叠顺序。
- 五个相关文件共 33 项定向检查通过，覆盖真实工作簿、图片与样式回归、三种图表、中文数据、空洞、区域引用、横向／百分比堆积选项、环形／面积／散点选项、未知类型、坏内容及资源限制。随后补充空缓存引用读取和不同系列类别校验，图表组 5 项再次通过。选项测试没有替代真实绘制证明；未运行全量桌面套件。
- 复用 `node scripts/sheet-preview.native.mjs --run`，最终 1 组通过。先打开不含图表的 XLS／ODS，实际请求中没有图表入口；再打开含图表的 XLSX，确认只加载一次独立入口。真实 ECharts 生成柱状、折线和饼图，图片实际解码并挂载，核对中文标题、360×240 尺寸与非空像素，同时保留三张图片的裁剪、翻转、只读、切表和面板尺寸回归。
- 已查看实际图表图片，中文标题和图形可见；折线样例中间值为空，因此断开而非补成零。最终记录与样例位于 `C:\Users\stan\AppData\Local\Temp\hermes-sheet-preview-OrnsJF`，含 XLSX／XLS／ODS、`picture-4.png`～`picture-6.png` 及 `report.json`。全局既有网络字体继续被阻断，其它外部请求和页面错误为空；Vite 仍有既有的分块弃用、动态导入和插件耗时提示。
- 完整 `npm run typecheck`、改动 TS 文件 ESLint 零警告、夹具语法和 `git diff --check` 通过。没有运行 Office、MaaS、Hermes 或用户窗口，没有打包、调用模型或连接真实远程。环形／面积／散点、复杂轴及多系列已做定向检查但未逐种实机视觉验收；真实账号文件、刷新手感、其它系统和安装包仍待用户核验。
- 人工验收：重启开发版，打开上述 XLSX，查看“月度销售”“趋势变化”“分类占比”三张图，再用自己的二维图表对照 Excel 检查系列、类别、位置、滚动、切表和保存后刷新。XLS／ODS 仍为基础预览，复杂或不支持图表走 PDF 候选。本步两个提交均留在本地，未推送，不进入 P16；Hermes Python 核心、账号管理、官方版和用户数据未改。
