---
name: uniai-ppt
description: "创建、编辑和检查专业演示文稿及 PPT 文件."
version: "1.0.0"
author: "UniWork"
license: 专有软件。完整条款请参阅 LICENSE.txt
platforms: [linux, macos, windows]
tags: [PPT, 演示文稿, 幻灯片]
---

# UniAI-PPT Skill

## 🚫 第 0 条铁律：技能目录只读，产物一律写在当前工作目录

本文开头那行 `Base directory for this skill: <路径>` 就是**技能根**，下文写作 `<技能根>`。

- **绝不 `cd` 进技能目录**，也绝不往里写任何东西。它是只读的安装目录，会被技能市场的更新整个覆盖——
  写进去的稿子既可能被清掉，也可能被打进下一次分发包发给别人。
- **调技能自带的脚本一律用绝对路径**：`node <技能根>/scripts/xxx.js`、`python <技能根>/scripts/xxx.py`、
  `<技能根>/themes/xxx.json`。下文所有命令都是这么写的，**照抄时不要把 `<技能根>/` 省掉**。
- **产物（`slides.js` / `theme.js` / `pptkit.js` / `output.pptx` / `research.md` / 图片）全部写在当前工作目录**，
  用 `./xxx` 相对路径。开工前先 `pwd` 确认自己在哪，需要的话建个子目录再进去。

> 实测事故：早期文档把命令写成不带前缀的 `python scripts/analyze_template.py`，在正常工作目录下必然报"找不到文件"，
> agent 就 `cd` 进技能目录去执行——之后整份稿子的产物（slides.js / output.pptx / 下载的图）全落在技能安装目录里。
> **路径写全是硬要求，不是风格问题。**

## ⚠️ 第一步：立刻创建 TODO LIST（不可跳过！）

**读完本段后，你的下一个动作必须是建 todo list（若环境提供 todo 工具就调它，没有就在回复里写出来）。不要先去处理素材、不要先调用 MCP、不要先安装任何库！**

> 错误示范：读完 skill → 直接调用 MCP 解析 PDF → 忘记流程 → 装错库
> 正确示范：读完 skill → **立刻建 todo list** → 按 todo 顺序执行

你的 todo list 必须包含以下关键环节（根据实际情况增减）：

0. **确认工作目录**：`pwd`，确认**不在技能目录里**；产物都写这儿（见上面第 0 条铁律）
1. 分析用户需求，确定主题和内容方向
2. 选择主题（从 `<技能根>/themes/` 里选匹配的主题 JSON）
3. 生成 theme.js：`node <技能根>/scripts/theme_generator.js <技能根>/themes/xxx.json ./theme.js`（**输出路径必须给，否则会写进技能目录**）；并拷出稿套件：`cp <技能根>/scripts/pptkit.js ./pptkit.js`
4. **先读 [components.md](components.md)（出稿套件用法）+ [master-template.md](master-template.md)（片单节奏），并定好片单**——先知道每页要什么，再去找素材，才不会搜一堆用不上的东西
5. 处理用户上传的素材（如有）→ **先本地解析**：`python <技能根>/scripts/process_upload.py --input <素材目录> --output <产物目录>`，文字/表格/图片全部本地抽，**不要调 MCP 解析 PDF**；只把产出的 `manifest.json` 里 `needs_vision` 那几张交给视觉 MCP（详见 [uploadprocess.md](uploadprocess.md)）。再需要配图时走「🖼 配图规则」：**联网搜真图 → 下载到本地 → mcp 视觉工具逐张验收（图文相符/画质构图/配色相容/适合做PPT素材）→ 通过才用**。**客观存在的东西一律搜真图，不要张口就生图**；抽象概念/统一风格图标/真实不存在的画面才用生图。没有合适的图就不放图
6. 将搜索结果和素材信息整理到 `research.md`；**素材处理完后重读一遍 components.md**（大量素材会把它挤出上下文）
7. 逐页生成幻灯片（每页生成后立即 `node slides.js`，**体检必须打印 ✅ 才能进下一页**；若环境提供 PptxProgress 就顺手报进度）
8. 若环境提供 PresentToUser 则调用它展示成果，否则直接把文件路径告诉用户

**重要提醒**：
- PPT 生成使用 **pptxgenjs**（Node.js 库），不是 python-pptx！
- **一切版式交给 `pptkit.js`：你只切区域、给数据，绝不手写 x/y 坐标和字号。** 手算坐标是「文字溢出 / 怪换行 / 元素重叠 / 一排卡三个字号」的唯一来源。
- 当你处理完大量素材后，你一定会忘记用法，所以第 6 步的重读是强制性的
- [components.md](components.md)（出稿套件 = 页型 + 区块 + 文案预算）是出稿主力，准备好素材后必读

## 🧭 开工前先选路（三条模板路线，二选一即可）

| 情况 | 走哪条 |
| --- | --- |
| 用户提到**联通/中国联通/数智/元景**（含联通科技风等变体） | → [unicom-template.md](unicom-template.md)（品牌精确复刻，最高优先） |
| 用户**上传了 pptx** 说"照这个做/套这个样式" | → [custom-template.md](custom-template.md)（先 `analyze_template.py` 拆解再复刻） |
| 其余从零创建（默认） | → 选主题 + [master-template.md](master-template.md) + [components.md](components.md) |

三条路都用同一个出稿套件 `<技能根>/scripts/pptkit.js`（页型 + 区块 + 自动防溢出 + 排版体检），也都遵守同一套底线：
**不手写坐标**、页序（封面→目录→内容→结束）、图层先底后内容、不主动文生图。速查见 [compact-reference.md](compact-reference.md)。

## 快速参考

如果你正在新做一个ppt，准备好素材（文字、数据、图片（图片必须下载到本地））后阅读 [pptxgenjs.md](pptxgenjs.md)，开始你的js创作，然后使用 pptxgenjs 工具转成 pptx。

| 任务 | 指南 |
| --- | --- |
| 🔴 **联通 / 中国联通 / 数智 / 元景 模板** | **最高优先级**，命中即用：阅读 [unicom-template.md](unicom-template.md)，按其 pptxgenjs 代码生成（含联通科技风/婉约风等变体） |
| ✨ **从零做（默认推荐流程）** | 选主题 → 读 [components.md](components.md)（出稿套件：5 种页型 + 10 个区块）+ [master-template.md](master-template.md)（片单节奏）逐页出稿 |
| 🧩 **出稿套件 pptkit** | `cp <技能根>/scripts/pptkit.js ./` 后 `require("./pptkit.js")(pres, THEME)`。**卡片/KPI/图表/流程/对比一律用它的区块，绝不手搓坐标**——它内建了防溢出（生成端反算字号）、同排字号统一、图层顺序、排版体检 |
| 📤 **用户上传了 pptx 模板**（照这个做/套这个样式） | 阅读 [custom-template.md](custom-template.md)：`python <技能根>/scripts/analyze_template.py <上传.pptx>` 自动拆出尺寸+配色+字体+logo+逐页坐标，再复刻 |
| 选择主题 | `node <技能根>/scripts/theme_generator.js <技能根>/themes/xxx.json ./theme.js`（输出路径必须给） |
| 布局参考（**只当灵感库**） | [layouts.md](layouts.md) 看版式点子即可；**落地一律用 [components.md](components.md) 的区块**，不要照抄里面的硬编码坐标 |
| 处理用户上传的素材 | 只要用户上传了素材，必须阅读 [uploadprocess.md](uploadprocess.md)（自己搜到的可以不读）。**解析在本地做**：`process_upload.py` 抽文字/表格/图片并自动去重，**MCP 只用来识图**，且只识 `manifest.json` 的 `needs_vision` 那几张 |
| **配图** | 见下方「🖼 配图规则」——**默认联网搜真实图片，文生图只在特定场景用**。这是硬规则，不是建议 |
| 从零创建 | 阅读 [pptxgenjs.md](pptxgenjs.md) |
| 可视化检查 | 要看一张图片的内容，**用 mcp 视觉工具，不要用 read**（产线环境 read 图片会导致不可逆的系统错误）。若环境没有 mcp 视觉工具，就跳过视检，改为严格保证每页 `[pptkit] ✅` |
| 读取/分析内容 | `python -m markitdown presentation.pptx` |
| 编辑或基于模板创建 | 阅读 [editing.md](editing.md) |
| 可视化检查与 QA | 阅读 [examin.md](examin.md) |
| **添加图表** | 见下方「图表生成」章节 |

***

## 🔴 联通品牌模板（命中关键词即最高优先，先于主题系统）

**这是一条优先级最高的硬规则，凌驾于下面的「主题系统」自动匹配之上。**

当用户的需求中出现以下**任意**关键词时，**必须**直接使用联通品牌模板，立刻阅读 [unicom-template.md](unicom-template.md)，按其中实测复刻的 pptxgenjs 代码逐页生成：

- `联通` `中国联通` `联通模板` `联通风格` `联通PPT` `联通ppt` `联通数智` `数智PPT` `联通元景` `元景`
- 以及**风格变体**：`联通科技风` `联通婉约风` `联通简约风` `联通商务风` …（即「联通 + 任意风格词」一律命中本模板）

规则要点：

1. **命中即优先**：不要再去 `<技能根>/themes/` 里做普通匹配，直接走联通模板（其自带的品牌主题为 `<技能根>/themes/unicom.json`，可 `node <技能根>/scripts/theme_generator.js <技能根>/themes/unicom.json` 生成 theme.js）。
2. **品牌主框架固定**：联通红 `C00000` + 亮红 `EE0000`、双 logo（中国联通 + 联通元景）、微软雅黑、红色页眉规则线、左侧红强调条——这些**不可更改**。
3. **风格词只调氛围**：科技风 / 婉约风 / 简约风等修饰词**只**影响辅助色与留白/装饰（详见 unicom-template.md 第 8 节「风格变体」），**绝不**改变上面的品牌身份。
4. **画布尺寸**：联通模板是 **13.333×7.5**，务必 `pres.defineLayout({name:"UNICOM",width:13.333,height:7.5})`，不要用默认的 `LAYOUT_16x9`。
5. logo 资源在 `<技能根>/templates/unicom/assets/`，源模板（可供编辑流复用）在 `<技能根>/templates/unicom.pptx`。
6. 🔴 **页序固定**：第 1 页封面 → 第 2 页目录 → 中间内容/章节页 → **最后一页结束页**。生成（addSlide）顺序就是最终页序，**绝不能**把目录放最后、结束页放前面。
7. 🔴 **封面/结束页禁背景图与 AI 生图**：联通封面就是**纯白底**（红标题+双logo+左红条+公司名/日期），不要 `background:{path}`、不要文生图、不要机房/科技背景图（会很违和）。
8. 🔴 **联通模板不主动文生图**：封面和内容页都不要主动调 mcp 文生图；视觉靠图表 + 品牌色块/卡片/数据大字/图标 + 联网搜索**下载**的真实图。**仅当用户明确要求配图/插画时**才文生图。这条**覆盖**本 skill 其它处"务必使用图片/文生图""封面用全出血背景图"等通用建议。
9. 🔴 **目录页不放子条目**：目录页只列一级章节（用 unicom-template.md 第 4 节的自动等距代码），**不要**把 1.1/1.2 子条目塞进目录页（会和下一行重叠成一坨黑字）。子目录放到对应章节页。
10. 🔴 **章节过渡页要么全有要么全无**：红底过渡页**要么每个一级章节前都放一张，要么一张都不放，严禁只给部分章节放**。默认 `章节数≥4 或 总页≥12` 才每章一张，否则全不放；放则序号/标题与目录页章节一一对应。**不要**为凑"布局多样性"零散插过渡页。

***

## 🖼 配图规则（默认搜真图，不要张口就生图）

**默认路径：联网搜真实图片 → 下载到本地 → 用视觉能力逐张验收 → 通过才用。**

为什么：PPT 里的图承担的是**佐证**功能——真实的景观、产品、场景、现场照片让人信；
AI 生成图一眼假（多指、扭曲文字、塑料光泽、不存在的建筑），放进要给领导看的稿子里是减分项。
凡是**客观存在**的东西——地点、景点、城市、建筑、产品、动植物、人物活动、历史场景、
设备、食物——**一律搜真图，不要生图**。

### 第一步：搜（默认）
用联网图片搜索，关键词要具体（"喀纳斯湖 晨雾"好过"新疆风景"）。**搜到的 URL 必须先下载到本地文件夹**，
`imageBlock` / `photoGrid` / `coverSlide({photo})` 用的都是本地路径；直接引用网址会失败（引擎会画占位块并告警）。

**配多少张，看题材——这条别搞反了**：

| 题材 | 用图量 |
| --- | --- |
| **实景类**：旅游/文旅、城市、餐饮、活动现场、产品、工程、人物、自然 | **正文页至少一半有图**，封面必用大图。这类稿子没有图就等于没做 |
| 数据/战略/管理类：财报、汇报、方案、白皮书 | 6–12 张点缀即可，不必每页都有；宁缺毋滥 |
| 纯数据类：董事会材料、审计、技术评审 | 可以一张不放，视觉全交给区块 |

实测教训：给了 6 张可用的新疆实景图，模型只在封面和一页正文里用了 2 张，剩下四页全是文字卡片——
一份旅游推介稿做成了工作汇报的样子。**判定标准很简单：把这份稿子给一个没去过的人看，他能"看见"你讲的地方吗？**

### 第二步：验（**这一步不能省**）
下载后**用 mcp 视觉工具逐张看过再用**（严禁用 read 读图）。四条验收标准，任一不过就换图重搜：

1. **图文相符** —— 图里的东西确实是你要讲的那个。搜索引擎经常给回同名不同物、示意图、
   带水印的图库预览图、甚至是插画/渲染图。**这是最容易翻车的一条。**

   > **判断依据只能是"我看到的画面"，不能是文件名、搜索结果标题、或别人给的图片说明。**
   > 实测里出过一次典型事故：素材清单把一张纽约中央公园鸟瞰写成"林木特写"、把一张
   > 趴在床上的斗牛犬写成"人文场景"，模型没看图就照单全收，于是稿子里出现了
   > 「喀纳斯 · 泰加林走廊」配摩天楼、「喀什老城手工艺人」配一只狗。
   > 这种错读者一眼就看见，杀伤力比任何排版问题都大。**一张都不能漏看。**
2. **画质与构图** —— 分辨率够（短边 ≥800px）、主体清晰、没有明显水印/logo/网站角标、
   不是拼图或截图、没有多余的边框和文字压在上面。
3. **配色相容** —— 图片主色调和当前主题的 `THEME.colors` 不打架。深色主题配高亮曝光图、
   暖色主题配冷调工业图，都会让页面割裂。同一份 deck 里的几张图**色调要接近**，别一张暖黄一张冷蓝。
4. **适合做 PPT 素材** —— 横构图优先（竖图放进宽屏会被裁掉主体）；主体不要顶在正中央
   （`page.photo` 和照片封面要在左下压字，主体在左下会被字盖住）；不要选信息量过载、
   看不出重点的图。

验收时就一句话记下结论（"喀纳斯湖晨雾，横构图，冷蓝调，主体在右，可用"），写进 `research.md`，
别把视觉工具的长输出留在上下文里。

### 第三步：配到哪一页
验收合格只说明"这张图能用"，不代表"能用在这一页"。落版时再对一次：

- **图必须是这一页在讲的那个东西。** 讲独库公路就放公路，别放一张同样漂亮的森林照——
  这是实测里真出现过的错，读者一眼就看出图文两张皮。`research.md` 里记的那句结论就是给这一步用的。
- **同一张图不要在两页重复出现**，重复用图比少放一张图更显得敷衍。
- 配不上就**这一页不放图**，去用区块。硬凑一张不相干的图是纯减分。

### 什么时候可以文生图
生图**不是禁用**，它在这几种情况下是更好的选择：

- **抽象概念**没有真实对应物：数据流动、算力网络、AI 大脑、生态协同这类示意画面；
- 需要**统一风格的图标/插画**（一套 4–6 个同风格图标，搜是搜不齐的）；
- 需要的画面**真实世界不存在**：产品概念图、未来场景、方案示意；
- **用户明确要求**插画/手绘/特定风格；
- 搜了 2–3 轮确实找不到合适的真图（这时也要在 `research.md` 里记一句"已搜 X，未找到，改用生图"）。

生成的图同样要过上面第 2/3/4 条验收；**并且同一份 deck 里不要真图和 AI 图混着用在同一类内容上**，
一眼就能看出不是一套。

### 最后
**没有合适的图，就不要放图。** 本技能的区块（KPI 条、表格、图表、流程、分层图、矩阵、照片墙）
不依赖图片也能出完整的商用观感——实测零图片的稿子照样是商用级。**为了凑图而配一张不相干的图，
比不配更减分。**

***

## 主题系统

**主题系统是保证 PPT 视觉一致性的核心机制。** 务必在生成任何幻灯片代码之前先选择并生成主题。

### 主题使用工作流

1. **列出可用主题**：`ls <技能根>/themes/`
2. **根据用户主题匹配最合适的主题**（参考下方主题目录表的 tags）
3. **生成 theme.js**：`node <技能根>/scripts/theme_generator.js <技能根>/themes/xxx.json ./theme.js`
4. **在 slides.js 中引用主题**：所有后续 JS 代码必须使用 `const THEME = require("./theme.js")`

### 主题目录（17 个预置主题）

| 文件名 | 显示名 | 适用标签 | 说明 |
| --- | --- | --- | --- |
| `midnight-executive.json` | 午夜高管 | corporate, finance, executive, formal | 深邃藏蓝+冰蓝，适合高管汇报、财务报告 |
| `forest-moss.json` | 森林苔藓 | nature, sustainability, eco, wellness | 有机绿调，适合环保、可持续发展主题 |
| `coral-energy.json` | 珊瑚活力 | creative, marketing, startup, vibrant | 珊瑚红+金色，适合创意营销、创业路演 |
| `ocean-gradient.json` | 海洋深蓝 | corporate, consulting, trust, professional | 专业海蓝，适合咨询、金融服务 |
| `charcoal-minimal.json` | 炭灰极简 | minimal, tech, architecture, design, modern | 极简炭灰，适合科技、设计展示 |
| `teal-trust.json` | 青绿信赖 | healthcare, science, education, trust | 沉稳青色，适合医疗、教育、科学 |
| `berry-cream.json` | 浆果奶油 | fashion, beauty, luxury, feminine | 浆果+奶油，适合时尚、美妆、奢侈品 |
| `sage-calm.json` | 鼠尾宁静 | wellness, interior, calm, lifestyle | 柔和鼠尾草绿，适合生活方式、冥想 |
| `cherry-bold.json` | 樱桃大胆 | bold, impact, sales, urgency | 高冲击力樱桃红，适合销售、产品发布 |
| `tech-innovation.json` | 科技创新 | tech, startup, AI, digital, innovation | 电光蓝+霓虹，适合AI、数字化转型 |
| `chinese-ink.json` | 水墨国风 | chinese, traditional, culture, elegant | 水墨美学，适合传统文化、历史、典雅报告 |
| `chinese-festive.json` | 国潮喜庆 | chinese, festival, celebration, new-year | 中国红+金色，适合年会、庆典、节日 |
| `medical-clean.json` | 医疗净白 | medical, healthcare, pharma, clinical | 临床蓝白，适合医疗报告、制药演示 |
| `education-warm.json` | 教育暖阳 | education, academic, school, training | 暖色学术蓝，适合教育培训、学术演示 |
| `finance-gold.json` | 金融尊贵 | finance, banking, investment, premium | 黑金配色，适合投资报告、银行演示 |
| `sunset-warm.json` | 暖阳日落 | warm, hospitality, food, artisan, creative | 暖橘+青绿，适合餐饮、旅游、手作 |
| `unicom.json` 🔴 | 联通红 China Unicom | unicom, 联通, 中国联通, 数智, 元景, telecom, red | 中国联通官方品牌（联通红 C00000+亮红 EE0000），配套 [unicom-template.md](unicom-template.md) 逐页模板。**联通相关一律用它，优先级最高** |

### 主题匹配建议

- 如果用户没有明确指定风格，根据 PPT 主题的**行业属性**和**情绪调性**选择最匹配的主题
- 如果用户指定了颜色偏好，选择最接近的主题，然后生成 theme.js 后可以手动微调颜色
- 中国传统/国风主题优先使用 `chinese-ink.json` 或 `chinese-festive.json`
- **任何中国联通 / 联通数智 / 联通元景 / 联通×风格 相关的 PPT，一律走联通品牌模板（`<技能根>/themes/unicom.json` + [unicom-template.md](unicom-template.md)），优先级高于此处的普通匹配**
- 不确定时，`midnight-executive.json` 和 `charcoal-minimal.json` 是万金油选择

***

## ⚠️ 重要：质量要求

注意，你要做出非常精美的 pptx 文件，信息密度要很大。**图片是可选增强，不是必需**——实测零图片同样能出完整的商用观感（视觉靠 pptkit 的区块：卡片/KPI/图表/流程/矩阵/分层图/照片墙）。**有合适的真实图片就用，没有就不用，绝不要为了凑图而配图。** 要用图就照「🖼 配图规则」办：**默认联网搜真图并逐张视觉验收，生图只用于抽象概念/统一风格图标/真实世界不存在的画面/用户明确要求**。你正在做的是要给领导看的拿去看的重要 pptx，务必做的非常精美。要有一个封面页，一个结束页。配色把控好，内容要充实，一定要有视觉素材！如果用户给你上传了素材，优先处理用户上传的素材！

### ✨ 商用级视觉（对标豆包 / Kimi，硬性目标）

出稿标准是"能直接拿去给领导汇报"，不是"能跑就行"。达标靠三件事，缺一不可：

1. **用套件的区块，别手搓**：卡片、KPI、图表、流程、对比、排行一律用 [components.md](components.md) 的区块（`featureRow`/`statRow`/`chartBlock`/`processRow`/`compareRow`/`barsBlock`…）。它们已封好图层顺序、圆角、阴影、间距、字号，并且**内部自动防溢出、同排字号统一**。
2. **不写坐标**：只能用 `rowsOf/colsOf/padOf` 切区域。页边距、间距、字号阶梯全部由套件统一，你越少插手越好看。
3. **主题统一**：颜色/字体全走 `THEME.xxx`，图表配色用 `chartColors(THEME)`；封面/结束深色、内容浅色的"三明治"节奏。
4. **文案即设计**：页标题写成**观点句**（结论+数字，如"算力投资占比超 35%，智算规模行业领先"）≤20 字，不写名词短语（"算力基建"❌）；卡片要点每条 ≤14 字、每卡 ≤4 条；research.md 里**最强的 3 个数字必须做成 `statRow` 大数字**；每张内容页配 1–2 句讲稿（`contentSlide({ note: "…" })`），客户拿到即可上台照读。
5. **结构有节奏**：按 [master-template.md](master-template.md)「标准片单蓝图」排页；相邻两张内容页**不得**用同一主组件（轮换铁律见 [components.md](components.md)）。

> 判断是否惊艳：把成品缩略图和豆包/Kimi 的商用 deck 并排看——若你的更空、更乱、卡片发虚发空，就是没用组件或没守令牌，回去改。

### 交付前终检（强制，只做一次，约 1 分钟）

全部页面完成后、调用 PresentToUser **之前**，必须做一轮快速视检：

```bash
python <技能根>/scripts/ppt_to_pic.py --file output.pptx --output thumbnails
```

用 mcp 视觉工具抽查 **封面 + 任一内容页 + 结束页** 三张图，核对：①无文字溢出 ②无空白卡片（图层错）③logo/页码齐全 ④页序对（封面首、目录次、结束页末）⑤深浅节奏正常。发现问题用 Edit 修 slides.js 对应页重跑，**不要整体重写**。

> **若渲染工具（LibreOffice/poppler）或 mcp 视觉工具不可用**：跳过这一步，但必须确保每页 `node slides.js` 都打印了 `[pptkit] ✅ 体检通过`，且没有 `⚠` 残留。体检能挡住溢出/重叠/越界，挡不住的是断行美感和信息密度——这两项自己按文案预算把关。

### 最小视觉复杂度规则

**每一张内容页至少需要 2 种视觉元素**（用 `page.*` 配方自然满足）。视觉元素包括：卡片、KPI 大数字、图表、排行条、chevron 流程、分层图、矩阵、图片。纯文字幻灯片只允许 `page.quote`。

### 布局多样性强制

- **同一种布局最多连续使用 2 次**（在一个 15 页的 PPT 中）
- **整个演示文稿至少使用 5 种不同的布局**（参考 [layouts.md](layouts.md)）
- 每 3 张幻灯片中至少有 1 张包含图片或图表

### 对于用户 query 的分析

用户的 query 有时候可能会很简单，比如做一个 ppt，主题是 xxx。为了做出非常精美的 pptx 文件，你需要默认去拿到视觉素材，去搜索相关的数据绘制图表，准备好素材然后阅读 [pptxgenjs.md](pptxgenjs.md)，创建 js，在 pptx 的内容页面用高信息密度和美观的布局精心制作的非常精美。可视化检查不是必须的，如果写完 js 后自己发现有些排版不是很美观，不要重写 js（除非用户明确要求重做全部的 ppt），优先使用 edit 工具编辑有问题的需要优化的部分，让整体更加美观好看，也可以转成图片之后使用 mcp 视觉工具分析哪里有问题，然后修改 js。

***

## ⚠️ 重要：逐页生成策略

**使用 PptxGenJS 创建 PPTX 时，务必采用逐页生成策略，确保每页生成后立即可验证、可展示进度。**

### 为什么要逐页生成？

1. **即时反馈**：每页生成后立即运行 `node slides.js`，可以尽早发现代码错误
2. **进度可见**：通过 PptxProgress 工具让用户实时看到制作进度
3. **避免灾难性错误**：如果第 10 页代码有 bug，前 9 页的成果不会丢失
4. **上下文友好**：逐页编写避免单次输出过长导致 token 溢出

### 逐页生成工作流

```
Step 1: 生成 theme.js（从选定主题）
Step 2: 写入 slides.js 头部（require 语句 + pres 初始化）
Step 3: 对于每一页幻灯片：
   a. 使用 Edit 工具将该页代码插入 slides.js（在 writeFile 行之前）
   b. 运行：node slides.js → 生成 output.pptx
   c. 调用 PptxProgress 工具向用户展示进度
Step 4: 所有页面完成后，调用 PresentToUser 展示最终 PPTX
```

### slides.js 结构示例

**第一步：写入文件骨架**

```javascript
const pptxgen = require("pptxgenjs");
const THEME = require("./theme.js");

let pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
const K = require("./pptkit.js")(pres, THEME);   // ← 必须！删了就会字超框、排版乱
const { page,                                    // ← 整页配方，内容页默认走它
        coverSlide, tocSlide, sectionSlide, contentSlide, closingSlide,
        rowsOf, colsOf, padOf, featureRow, statRow, timelineRow, processRow,
        compareRow, barsBlock, chartBlock, imageBlock, quoteBlock, bulletBlock,
        layersBlock, matrixBlock, charts } = K;

// === SLIDES START ===

// （后续每页代码插入到这里 —— 只用页型 + rowsOf/colsOf + 区块，不写坐标）

// === SLIDES END ===

pres.writeFile({ fileName: "output.pptx" }).then(() => {
  console.log("output.pptx created");
});
```

> 前置：`cp <技能根>/scripts/pptkit.js ./pptkit.js`（和 slides.js 同级）。完整用法见 [components.md](components.md)。

**第二步：使用 Edit 工具逐页插入代码**

每次新增一页幻灯片时，使用 Edit 工具在 `// === SLIDES END ===` 行之前插入新的幻灯片代码。例如：

```
old_string: "// === SLIDES END ==="
new_string: "// --- Slide 1: 封面 ---\nconst slide1 = pres.addSlide();\n...\n\n// === SLIDES END ==="
```

务必注意：每次插入新代码后，`// === SLIDES END ===` 标记仍然保留在代码末尾（writeFile 之前），方便下一页继续插入。

**第三步：每插入一页后立即运行并报告进度**

```bash
node slides.js
```

如果运行报错，立即修复该页代码，不要继续下一页。

**同时必须看 pptkit 的体检输出：**
- `[pptkit] ✅ 体检通过：无溢出、无越界、无重叠` → 才能进下一页
- `[pptkit] ✗ 内容缺失 N 处` → **这一页有区块一个字都没画出来**，`writeFile` 会直接拒绝出稿、不生成 pptx。
  报错会写清是哪个区块、缺哪个字段、你实际传的是什么键名 —— 绝大多数情况就是**键名写错了一个字**
  （`items` / `lines` / `steps` / `layers` / `quadrants` / `head`+`rows` 各块不同，别凭直觉写），
  或者在 `compose` / `page.free` 里**把区块名拼错了**。照报错改键名，别去改数据。
  同样会被硬拦的还有三类：
  ① **整页只有页眉** —— `contentSlide` / `page.*` 建了页却没画任何区块（或 `blocks: []`）；
  ② **图片不存在** —— 搜来的图必须先下载到本地；实在没图就**把图片区块删掉**改纯文字版式，
     不允许交一个「图片缺失」灰块；
  ③ **数据是空壳** —— `items:[{}]`、`chapters:[""]`、`compareRow` 只给半边、`matrixBlock` 不是正好 4 象限（多给的会被丢掉）。

> 为什么值得单列一条：这类错误以前是**静默**的 —— 页眉照画、体检照打 ✅、pptx 照出，
> 只是那一页正文整块消失，一路交到用户手里才被发现。现在它会硬失败，就是为了不让它再溜过去。

> **🚫 拒绝出稿之后的硬规则（没有例外）**
> 1. 出现 `[pptkit] 拒绝出稿` = **这一轮没有产出任何文件**。必须照报错改 `slides.js` 并重新运行
>    `node slides.js`，直到它成功出稿为止。
> 2. 在 `node slides.js` 成功出稿之前，**禁止**调用 `PptxProgress`、**禁止**调用 `PresentToUser`、
>    **禁止**向用户宣告“已完成/已生成”。
> 3. **禁止交付目录里残留的旧 `output.pptx`**。上一次跑成功留下的那个是旧版本、页数不全；
>    pptkit 已经把它改名成 `output.pptx.rejected` 了，看到这个名字就说明本轮**还没有**成果。
> 4. 改不动、连续两次都失败时，**如实告诉用户哪一页出了什么问题**，也不要交一个不完整的文件。
>    交半份 PPT 比说“我没做完”糟糕得多 —— 用户不会知道少了什么。
- `[pptkit] ⚠ 排版问题 N 处` → **先按提示改完再继续**（对照表见 [compact-reference.md](compact-reference.md)）。攒到最后再改必然返工。

**第四步：运行成功后，立即调用 PptxProgress 工具报告进度（必须！）**

⚠️ **这一步是强制性的！** 每页 `node slides.js` 成功后必须调用 PptxProgress：

```json
{
  "file_path": "/path/to/output.pptx",
  "current_slide": 1,
  "total_slides": 5,
  "slide_title": "封面",
  "slides_completed": ["封面"]
}
```

第二页生成成功后：
```json
{
  "file_path": "/path/to/output.pptx",
  "current_slide": 2,
  "total_slides": 5,
  "slide_title": "目录",
  "slides_completed": ["封面", "目录"]
}
```

以此类推，每页运行成功后都要调用 PptxProgress。确认成功后再生成下一页。

### 大型演示文稿的备选方案

对于超过 20 页的大型演示文稿，如果逐页生成遇到 JS 文件过大的问题，可以使用 `merge_slides.py` 作为备选方案：

1. 将每页生成为独立的 PPTX 文件（slide_01.pptx, slide_02.pptx, ...）
2. 运行合并脚本：`python <技能根>/scripts/merge_slides.py slide_01.pptx slide_02.pptx ... -o final.pptx`

但在绝大多数情况下（20 页以内），直接使用单文件逐页插入策略即可。

***

## 上下文管理

**这是防止 AI 在长对话中"遗忘"关键指令的核心机制。** 素材搜索和处理阶段会产生大量文本，将重要的技术参考挤出上下文窗口，导致生成的 JS 代码质量下降。必须严格遵守以下规则：

### 规则 1：搜索结果文件化

联网搜索完成后，必须将关键发现（数据、事实、要点）整理写入 `research.md` 文件。**严禁**将原始搜索结果保留在对话上下文中。写完 research.md 后，后续引用数据时从文件中读取。

### 规则 2：MCP 输出精简

当 MCP 工具（文生图、视觉分析等）返回大段内容时，提取关键信息（图片路径、分析结论），保存到文件。**严禁**将原始 MCP 输出长时间保留在上下文中。

### 规则 3：阶段切换

素材处理完毕后，必须明确地进行阶段切换。在对话中输出以下标记：

> **素材准备完毕，开始生成幻灯片。**

这是给自己的提醒：从此刻起，专注于 JS 代码生成，不再进行素材搜索。

### 规则 4：强制重读

在开始生成 JS 代码之前，**必须重新阅读**以下两个文件：
- [components.md](components.md) — 出稿套件 pptkit（页型 + 区块 + 文案预算），**这是主力**
- [compact-reference.md](compact-reference.md) — 每页必读的硬规则速查

**这是不可协商的硬性要求。** 原因：大量的搜索结果和素材处理内容已经将这些关键参考推出了上下文窗口。不重读就写代码，必然会犯低级错误（颜色格式错误、API 用法错误、布局不美观等）。

### 规则 5：紧凑速查

在编写每一页幻灯片的 JS 代码之前，重新阅读 [compact-reference.md](compact-reference.md)。这个文件非常短（30 行），包含了 PptxGenJS 最关键的规则速查。每页都重读一次，成本极低但能有效避免常见错误。

***

## 网络搜索

请使用你内置的网络搜索工具搜索内容和图片以丰富你的演示文稿。搜到图片之后接口会给你 url 和图片的名称，必须下载到本地的文件夹里！必须下载！下载了才能使用！

**搜索完成后的上下文管理：** 将搜索到的关键信息（数据、事实、引用）整理到 `research.md` 文件中。图片下载到本地文件夹后，在 research.md 中记录图片路径和用途说明。这样做可以释放上下文空间，为后续的 JS 代码生成留出余量。

**限制：**

- 文本搜索：每次会话最多 10 次查询
- 图片搜索：每次会话最多 10 次查询

**使用场景：**

- 收集事实和数据
- 寻找设计参考图片
- 研究主题背景

***

## 高级视觉设计技巧

**以下是经过大量实践验证的设计经验，能显著提升 PPT 的专业感。** 在编写每页 JS 代码时，务必参考这些技巧。

### 封面页设计

**方案 A：全出血背景图 + 暗色遮罩**

- 使用一张高质量全屏背景图（`slide.background = { path: imagePath }`）
- 叠加 50-60% 透明度的深色矩形遮罩
- 白色大标题居中，字号 44pt+
- 副标题在标题下方，字号 18-20pt，略微弱化

**方案 B：纯色深底 + 左对齐大标题**

- 纯深色背景（使用 `THEME.colors.bg_dark`）
- 标题左对齐，字号 44-48pt，占据左半部分
- 右侧放置一个装饰性形状（如半透明的大圆或矩形），使用 `THEME.colors.accent`

### 内容页层次感

**卡片式设计：**

- 白色圆角卡片（`ROUNDED_RECTANGLE`）+ 阴影（`THEME.cardShadow()`）+ 深色/灰色背景
- 卡片内保持 0.2-0.3" 内边距
- 多个卡片等间距排列，形成整齐的网格感

**左侧强调条：**

- 4px 宽的 accent 色竖线（使用 `THEME.accentBar()`）+ 右侧内容块
- 适合强调关键论点或引用

**图标圆圈：**

- 使用 accent 色填充的圆形（`OVAL`），统一 0.5" 直径
- 圆内放置白色图标图片，统一 0.35-0.4" 大小
- 圆形下方放标题和描述文字

### 数据展示

**大数字突出：**

- 核心数据使用 60-72pt 字号，accent 颜色
- 数据下方放小号标签（14-16pt），说明数据含义
- 可选趋势箭头或百分比变化

**趋势箭头：**

- 使用形状组合（三角形 + 线条）表示上升/下降
- 上升用绿色/accent 色，下降用红色
- 旁边标注百分比数字

**对比色块：**

- 正面/好的用绿色系或 accent 色
- 负面/差的用红色系
- 并排放置形成强烈视觉对比

### 图片处理

**半屏图片：**

- 图片占据半边（5" x 5.625"），另一半放文字内容
- 使用 `sizing: { type: "cover", w: 5.0, h: 5.625 }` 确保图片填满

**多图网格：**

- 统一尺寸、等间距（0.2-0.3"）排列
- 使用 `sizing: { type: "cover" }` 统一裁切
- 图片下方可加简短说明文字

**图片叠加文字：**

- 图片铺满背景
- 叠加半透明遮罩（`transparency: 40-60`）
- 遮罩上放白色文字

***

## 读取内容

```bash
# 文本提取
python -m markitdown presentation.pptx

# 可视化概览
python <技能根>/scripts/thumbnail.py presentation.pptx

# 原始 XML
python <技能根>/scripts/office/unpack.py presentation.pptx unpacked/
```

***

## 编辑工作流

**完整详情请阅读** **[editing.md](editing.md)。**

1. 使用 `thumbnail.py` 分析模板
2. 解包 → 操作幻灯片 → 编辑内容 → 清理 → 打包

***

## 图表生成

**为演示文稿添加精美图表，让数据可视化更具冲击力。**

### 图表类型选择指南

根据数据特征选择最合适的图表类型：

| 数据类型 | 推荐图表 | 用途 |
| --- | --- | --- |
| **时间序列** | `line_chart`, `area_chart` | 趋势、累积变化 |
| **对比** | `bar_chart`, `column_chart` | 类别对比、Top-N 排行 |
| **占比** | `pie_chart`, `treemap_chart` | 整体与部分、层级占比 |
| **相关性** | `scatter_chart`, `dual_axes_chart` | 变量关系、双轴对比 |
| **流程** | `funnel_chart`, `flow_diagram` | 转化漏斗、流程步骤 |
| **分布** | `histogram_chart`, `boxplot_chart`, `violin_chart` | 频率分布、统计分布 |
| **层级** | `organization_chart`, `mind_map` | 组织结构、思维导图 |
| **地理** | `district_map`, `pin_map`, `path_map` | 区域数据、点位、路线 |
| **专项** | `radar_chart`, `liquid_chart`, `word_cloud_chart`, `network_graph`, `sankey_chart`, `venn_chart`, `fishbone_diagram` | 多维对比、进度、词频、网络、流向、交集、因果 |

### 图表生成方法

#### 方法一：图片图表（推荐用于复杂图表）

生成高质量图表图片，然后插入幻灯片。适合需要精美视觉效果或复杂图表类型。

```bash
# 生成图表图片
node <技能根>/scripts/generate.js '{"tool":"generate_pie_chart","args":{"data":[{"category":"A","value":35},{"category":"B","value":45},{"category":"C","value":20}],"title":"市场份额","theme":"dark"}}'
```

返回图表图片 URL，然后在 JavaScript 中使用：

```javascript
// 在 PptxGenJS 中插入图表图片
slide.addImage({
  path: "返回的图表URL",
  x: 0.5, y: 1.5, w: 4.5, h: 3.5
});
```

**图表参数规格详见** **[references/](references/)** **目录下的各图表文档。**

#### 方法二：原生图表（适合简单图表）

使用 PptxGenJS 内置图表功能，适合快速创建简单柱状图、折线图、饼图。

```javascript
// 柱状图
slide.addChart(pres.charts.BAR, [{
  name: "销售额", labels: ["Q1", "Q2", "Q3", "Q4"], values: [4500, 5500, 6200, 7100]
}], {
  x: 0.5, y: 0.6, w: 6, h: 3, barDir: 'col',
  showTitle: true, title: '季度销售',
  chartColors: ["0D9488", "14B8A6", "5EEAD4"],
  showValue: true, dataLabelPosition: "outEnd"
});

// 饼图
slide.addChart(pres.charts.PIE, [{
  name: "份额", labels: ["A", "B", "其他"], values: [35, 45, 20]
}], { x: 7, y: 1, w: 5, h: 4, showPercent: true });
```

### 方法选择建议

| 场景 | 推荐方法 | 原因 |
| --- | --- | --- |
| 简单柱状/折线/饼图 | 原生图表 | 快速、代码简洁 |
| 需要与PPT主题配色统一 | 原生图表 | 可自定义颜色 |
| 复杂图表类型（雷达图、桑基图等） | 图片图表 | 原生不支持 |
| 需要精美视觉效果 | 图片图表 | 更丰富的视觉样式 |
| 需要动态交互 | 原生图表 | 可在PPT中编辑 |
| 暗色主题/特殊样式 | 图片图表 | 支持多种主题 |

### 图表主题与样式

图片图表支持三种主题：

- `default` - 标准白色背景
- `dark` - 深色背景，适合深色PPT
- `academy` - 学术风格

自定义配色：

```json
{
  "tool": "generate_column_chart",
  "args": {
    "data": [...],
    "title": "销售数据",
    "theme": "dark",
    "style": {
      "palette": ["#1E2761", "#CADCFC", "#FFFFFF"],
      "backgroundColor": "#1a1a2e"
    }
  }
}
```

### 详细图表规格

每种图表的完整参数说明，请参阅对应的参考文档：

- `references/generate_line_chart.md` - 折线图
- `references/generate_bar_chart.md` - 条形图
- `references/generate_column_chart.md` - 柱状图
- `references/generate_pie_chart.md` - 饼图/环图
- `references/generate_area_chart.md` - 面积图
- `references/generate_scatter_chart.md` - 散点图
- `references/generate_radar_chart.md` - 雷达图
- `references/generate_funnel_chart.md` - 漏斗图
- `references/generate_treemap_chart.md` - 树图
- `references/generate_sankey_chart.md` - 桑基图
- `references/generate_dual_axes_chart.md` - 双轴图
- 以及其他 15+ 种图表类型

***

## 从零创建

**完整详情请阅读** **[pptxgenjs.md](pptxgenjs.md)。**

当没有模板或参考演示文稿可用时使用。

***

## 设计思路

**不要创建无聊的幻灯片。** 白底黑字的简单列表无法打动任何人。为每张幻灯片考虑以下设计思路。

### 开始之前

- **视觉母题一致性**：选择一个独特的视觉元素并在所有幻灯片中重复使用 —— 圆角图片框、彩色圆形图标、单侧粗边框。在每张幻灯片中贯彻使用。这是将一组散乱幻灯片变成一套专业演示文稿的关键。
- **"三明治"结构**：深色封面 → 浅色内容页 → 深色结尾页。或者全程使用深色背景以营造高端感。这种明暗交替创造视觉节奏感。
- **选择大胆、契合内容的配色方案**：配色应为此主题量身设计。如果将你的配色方案换到一个完全不同的演示文稿中仍然"适用"，说明你的选择还不够具体。使用主题系统（`THEME.colors.xxx`）确保配色一致性。
- **主次分明而非均等分配**：一种颜色应占主导地位（60-70% 视觉权重），配以 1-2 种辅助色调和一种锐利的强调色。永远不要给所有颜色相等的权重。
- **坚持一个视觉母题**：选择一个独特的元素并重复使用 —— 圆角图片框、彩色圆形图标、单侧粗边框。在每张幻灯片中贯彻使用。

### 配色方案

使用主题系统后，配色已通过 `THEME.colors.xxx` 统一管理。以下配色方案可作为手动选择的参考，或在没有使用主题系统时使用：

| 主题 | 主色 | 辅色 | 强调色 |
| --- | --- | --- | --- |
| **午夜高管** | `1E2761`（藏蓝） | `CADCFC`（冰蓝） | `FFFFFF`（白色） |
| **森林苔藓** | `2C5F2D`（森林绿） | `97BC62`（苔藓绿） | `F5F5F5`（奶油色） |
| **珊瑚活力** | `F96167`（珊瑚红） | `F9E795`（金色） | `2F3C7E`（藏蓝） |
| **暖赤陶** | `B85042`（赤陶色） | `E7E8D1`（沙色） | `A7BEAE`（鼠尾草） |
| **海洋渐变** | `065A82`（深海蓝） | `1C7293`（青色） | `21295C`（午夜蓝） |
| **炭灰极简** | `36454F`（炭灰） | `F2F2F2`（灰白） | `212121`（黑色） |
| **青绿信赖** | `028090`（青色） | `00A896`（海泡色） | `02C39A`（薄荷绿） |
| **浆果奶油** | `6D2E46`（浆果色） | `A26769`（玫瑰灰） | `ECE2D0`（奶油色） |
| **鼠尾草宁静** | `84B59F`（鼠尾草） | `69A297`（桉树绿） | `50808E`（板岩灰） |
| **樱桃大胆** | `990011`（樱桃红） | `FCF6F5`（灰白） | `2F3C7E`（藏蓝） |

### 每张幻灯片

**每张幻灯片都需要至少 2 种视觉元素** —— 图片、图表、图标、形状的组合。纯文字的幻灯片容易被遗忘。

**布局选项（详见 [layouts.md](layouts.md)）：**

- 双栏（左侧文字，右侧插图）
- 图标 + 文字行（彩色圆圈中的图标，粗体标题，下方描述）
- 2x2 或 2x3 网格（一侧放图片，另一侧放内容块网格）
- 半出血图片（完整的左侧或右侧）配内容覆盖

**数据展示：**

- 大号数据突出（60-72pt 大数字，下方小标签）
- 对比栏（前后对比、优缺点、并排选项）
- 时间线或流程图（编号步骤，箭头）
- **精美图表**（使用图表生成功能，数据可视化更具冲击力）

**视觉打磨：**

- 章节标题旁的小彩色圆圈图标
- 关键数据或标语使用斜体强调文字

### 排版

**选择有趣的字体搭配** —— 使用主题系统时字体已自动配置（`THEME.fonts.title` / `THEME.fonts.body`）。手动选择时参考以下搭配：

| 标题字体 | 正文字体 |
| --- | --- |
| Georgia | Calibri |
| Arial Black | Arial |
| Calibri | Calibri Light |
| Cambria | Calibri |
| Trebuchet MS | Calibri |
| Impact | Arial |
| Palatino | Garamond |
| Consolas | Calibri |

| 元素 | 字号 |
| --- | --- |
| 幻灯片标题 | 36-44pt 粗体 |
| 章节标题 | 20-24pt 粗体 |
| 正文文本 | 14-16pt |
| 说明文字 | 10-12pt 弱化 |

### 间距

- 最小边距 0.5 英寸
- 内容块之间 0.3-0.5 英寸
- 留出呼吸空间 —— 不要填满每一寸

### 避免事项（常见错误）

- **不要重复使用相同布局** —— 在幻灯片间变化使用栏、卡片和突出显示
- **正文不要居中** —— 段落和列表左对齐；只有标题居中
- **不要吝啬字号对比** —— 标题需要 36pt+ 才能与 14-16pt 正文区分
- **不要默认使用蓝色** —— 选择反映特定主题的颜色（优先使用主题系统）
- **不要随意混合间距** —— 选择 0.3" 或 0.5" 间隙并保持一致
- **不要只设计一张幻灯片而让其他保持朴素** —— 要么完全投入，要么全程保持简洁
- **不要创建纯文字幻灯片** —— 添加图片、图标、图表或视觉元素；避免纯标题 + 列表
- **不要忘记文本框内边距** —— 当将线条或形状与文本边缘对齐时，在文本框上设置 `margin: 0` 或偏移形状以考虑内边距
- **不要使用低对比度元素** —— 图标和文字都需要与背景形成强对比；避免浅色背景上的浅色文字或深色背景上的深色文字
- **绝对不要在标题下使用装饰线** —— 这是 AI 生成幻灯片的标志；改用留白或背景色
- **代码的字符串定界符**始终用标准 ASCII 引号（`' '` 或 `" "`），别用中文引号当定界符
- **但文案内容里要加引号强调时，只能用「」或《》**：`"..."` 里面再写一个 ASCII `"` 会把字符串截断，
  直接 SyntaxError，整份稿子生成不出来。写 `title: "从「能用」转向「好用」"`，
  **不要**写 `title: "从"能用"转向"好用""`。实测这是单次生成失败的头号原因

***

## 设计质量检查清单

创建完幻灯片后，对照以下清单进行自我检查：

**布局与对齐**

- [ ] 图片、表格、图表是否对齐（底部或顶部对齐）？
- [ ] 文字块之间间距是否一致（统一使用 0.3" 或 0.5"）？
- [ ] 是否避免了"后加"的感觉——底部内容是否与整体融为一体？
- [ ] 布局是否多样化（至少 5 种不同布局）？
- [ ] `node slides.js` 的 pptkit 体检是否全程 `✅`（无溢出/越界/重叠/文案过长）、且没有任何 `✗ 内容缺失`？
- [ ] 卡片/数据/时间线是否都用了 pptkit 区块，而非手搓 addShape+addText 和硬编码坐标？

**视觉层次**

- [ ] 标题字号是否足够大（36pt+）与正文区分？
- [ ] 是否有清晰的视觉焦点（主图、核心数据、关键结论）？
- [ ] 信息密度是否适中——既不拥挤也不空洞？
- [ ] 每页是否至少有 2 种视觉元素？

**主题一致性**

- [ ] 是否使用了主题变量（`THEME.xxx`）而非硬编码颜色？
- [ ] 是否使用了 `THEME.titleStyle()` / `THEME.bodyStyle()` 等工厂函数？
- [ ] 视觉母题是否在所有幻灯片中保持一致？

**图表与图片**

- [ ] 图表颜色是否与整体配色方案协调？
- [ ] 图表是否与文物/照片风格统一？
- [ ] 图表是否放置在合适的位置——不是孤立在角落？

**内容完整性**

- [ ] 每张幻灯片是否有明确的单一主题？
- [ ] 数据是否有来源标注？
- [ ] 结论是否清晰可见？

**进度与交互**

- [ ] 是否调用了 PptxProgress 报告每页进度？
- [ ] 最终是否调用了 PresentToUser 展示成果？

**可视化检查**

```bash
# 生成缩略图检查整体效果
python <技能根>/scripts/ppt_to_pic.py --file presentation.pptx --output thumbnails

# 使用 Qwen 视觉分析
python <技能根>/scripts/vision_qwen.py --image thumbnails/slide1.PNG --prompt "分析这张幻灯片的设计质量和改进建议"
```

***

## 依赖项

**核心依赖：**

- `pip install "markitdown[pptx]"` - 文本提取
- `pip install Pillow` - 缩略图网格
- `npm install -g pptxgenjs` - 从零创建
- LibreOffice (`soffice`) - PDF 转换（Linux）
- Poppler (`pdftoppm`) - PDF 转图片
- **中文字体兜底**：Linux 沙箱若无微软雅黑（渲染出方块），把 theme.js 的 `fonts.title/body` 改为 `"Noto Sans CJK SC"` 或 `"WenQuanYi Micro Hei"` 后重跑

**主题生成：**

- `node <技能根>/scripts/theme_generator.js` - 从主题 JSON 生成 theme.js（Node.js 内置，无额外依赖）

**可视化工具：**

- `pip install tencentcloud-sdk-python` - 腾讯搜索 API
- `pip install svglib reportlab` - SVG 转 PNG，用于视觉工具

**图表生成：**

- Node.js >= 18.0.0 - 运行图表生成脚本

**幻灯片合并（备选）：**

- `pip install python-pptx` - 用于 merge_slides.py

***

## 环境设置

为获得可视化工具和网络搜索的最佳效果：

```bash
# 验证主题生成
node <技能根>/scripts/theme_generator.js <技能根>/themes/midnight-executive.json test-theme.js && cat test-theme.js && rm test-theme.js

# 验证工具工作正常
python <技能根>/scripts/template_manager.py list

# 验证图表生成
node <技能根>/scripts/generate.js '{"tool":"generate_column_chart","args":{"data":[{"category":"测试","value":100}],"title":"测试图表"}}'

# 验证 LibreOffice 安装
soffice --version

# 验证 pdftoppm 安装
pdftoppm -v

# 验证 PptxGenJS 安装
node -e "const p = require('pptxgenjs'); console.log('pptxgenjs OK');"
```
