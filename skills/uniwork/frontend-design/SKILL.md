---
name: frontend-design
description: "设计和改造网页、组件、落地页及数据看板界面."
version: "1.0.0"
author: "UniWork"
license: Complete terms in LICENSE.txt
platforms: [linux, macos, windows]
tags: [前端, 设计, UI]
---

# Frontend Design

Approach this as the design lead at a small studio known for giving every client a visual identity that could not be mistaken for anyone else's. This client has already rejected proposals that felt templated, and is paying for a distinctive point of view: make deliberate, opinionated choices about palette, typography, and layout that are specific to this brief, and take one real aesthetic risk you can justify.

哲学层负责"往哪走"，硬规则层负责"别踩雷"，两者配合使用。按本文顺序执行：读 brief → 设旋钮 → 定路线 → 取素材 → 做设计 → 核硬规则 → 跑预检。

## 交付契约

- **入口文件必须是 `index.html`**，写入当前工作目录（workspace）。多页时其余页面同级放置。
- **单文件自包含**：CSS/JS 全部内联，双击即可离线打开。例外见 §3。
- **中文优先**：除非另有说明，界面文案用简体中文，字体栈必须含中文字族（§6）。
- **必须截图自检**：本机装有无头浏览器，改完渲染看过再交付（§9）。未截图 = 未完成。

---

## 1. 读懂 brief（动手前）

先推断用户到底想要什么，别一上来就套默认审美。读这些信号：**页面类型**（落地页/作品集/重设计/编辑博客/文档报告）、**氛围词**（极简/Linear 风/Awwwards/brutalist/高端消费/科技暗黑…）、**参考信号**（链接/截图/点名的产品）、**受众**（B2B 采购 vs 设计敏感消费者 vs 招聘方）、**已有品牌资产**（logo/色/字）、**隐性约束**（无障碍优先/政企/受监管——这些**压过**审美偏好）。

若 brief 没定清产品/主题是什么，自己定：说出一个具体主题、它的受众、这一页的唯一任务。记忆里有用户偏好/在建项目/过往设计就拿来当线索。

动手前用一句话声明设计判断：**"我把这理解为：给〈受众〉的〈页面类型〉，用〈氛围〉语言，偏向〈设计系统/审美家族〉。"** brief 模糊且判断有分歧时，**只问一个**最关键的澄清问题；能自信推断就别问。

## 2. 三旋钮（先设定，后面所有布局/动效/密度决策都受它约束）

- **DESIGN_VARIANCE 设计方差**：1=完全对称，10=艺术化混乱。基线 **8**。
- **MOTION_INTENSITY 动效强度**：1=静止，10=电影级/物理。基线 **6**。
- **VISUAL_DENSITY 视觉密度**：1=画廊/空灵，10=驾驶舱/数据密集。基线 **4**。

按 brief 调档：

| brief 类型 | VARIANCE | MOTION | DENSITY |
|---|---|---|---|
| 极简/干净/Linear 风 | 5-6 | 3-4 | 2-3 |
| 高端消费/Apple 感 | 7-8 | 5-7 | 3-4 |
| playful/agency/Awwwards | 9-10 | 8-10 | 3-4 |
| 政企/受监管/无障碍优先 | 3-4 | 2-3 | 4-5 |
| 文档/报告/白皮书 | 3-5 | 1-2 | 5-6 |

旋钮是承诺：声称 MOTION 7 却全静止 = 预检失败。做不出就把旋钮调低，做一个干净的静态页，别虚报。

## 3. 实现路线：官方设计系统 vs 原生 CSS

brief 明确命中某个体系时，装官方包、别手抄它的 CSS，也别导入它的 token 又覆盖 90%：

| brief 信号 | 用 |
|---|---|
| 微软企业/仪表盘 | Fluent UI |
| Material 风 | Material 3 |
| IBM 风 | Carbon |
| GitHub 风 | Primer |
| 英国政务 / 美国政务 | govuk-frontend / USWDS |
| 自有组件的现代 SaaS | shadcn/ui |
| Tailwind 现代 SaaS | Tailwind |

**一个项目一套系统，不混用。**

与交付契约的取舍（重要）：
- 单文件自包含是默认。走设计系统时**优先官方 CDN 引入**，并在交付说明里写清"本页需联网加载 X"。
- brief 明确要工程化（React/Vue/构建工具）时，才建目录装包，入口仍为 `index.html`。
- brief 只是"某种审美"而非"某个系统"（玻璃拟态/bento/brutalism/编辑杂志风…）→ **用原生 CSS 实现**，并在注释里诚实标注"借鉴 vs 官方"。

## 4. 素材：先取真图真事实（动手前完成）

裸模型会默认塞随机占位图或灰块，这是"AI 味"的一大来源。**占位图是兜底，不是默认。**

1. **要真实产品图 / 品牌 logo / 配图** → 先用**联网搜索**（内置 Web Search 或环境里的搜索类 MCP，结果通常自带图片字段）按主体检索真实图片 URL，把图片直链用进 `<img src>`。涉及某真实品牌时，**它的官方 logo 是必需资产**。
2. **涉及真实品牌/产品的事实**（配色、规格、价格、发布状态）→ 先**联网核实**再写进页面，别凭记忆编造；品牌色以官网/官方 VI 为准。
3. **图生图**（若环境可用）→ 需要氛围图/纹理/hero 主视觉且搜不到合适真图时，按 section 尺寸生成，别手搓烂 SVG。
4. **兜底才用** `picsum.photos/seed/{描述}/{w}/{h}`。

外链图片会让页面离线时破相：关键视觉给 `alt` 与容器背景色兜底，体积小的核心图（logo/图标）尽量转 base64 内联。

## 5. 设计原则（哲学层，先想清楚"往哪走"）

- **扎根主题**：主题自身的世界——它的材料、工具、器物、行话——才是独特选择的来源。全程用 brief 的真实内容与题材来搭建。
- **选一个极端调性并精确执行**：brutally minimal / maximalist chaos / retro-futuristic / organic·natural / luxury·refined / playful·toy-like / editorial·magazine / brutalist·raw / art deco·geometric / soft pastel / industrial·utilitarian。极繁与极简都成立，**关键是意图明确，不是强度**。这份清单是灵感起点，不是选项穷举。
- **Hero 是论点**：用主题世界里最有代表性的东西开场（一句标题、一张图、一个动效、一个可交互瞬间），别默认"大数字+小标签+渐变"这个模板答案。
- **排版承载个性**：display 与 body 字体刻意搭配，定清楚字号阶梯、字重、字距，让排版本身成为记忆点。**跨次生成不许收敛**——不要每个项目都抓同一套（Inter、Roboto、Space Grotesk 是典型收敛点）；这次用过的组合，下次换。
- **结构即信息**：编号/眉标/分割线/标签要编码内容里真实存在的东西，不是装饰。内容真是个序列（真实流程、时间线）才用 01/02/03。
- **背景要有空气**：别默认纯色平铺。用与调性匹配的质感造氛围与纵深——噪点/颗粒、细几何底纹、分层半透明、戏剧化阴影、装饰性边框。注意这是**被硬规则约束的**：不许滑向 AI 紫蓝渐变 mesh 与满屏玻璃拟态（§7）。
- **动效要克制且有理由**：一个精心编排的页面载入（`animation-delay` 错峰揭示）通常比到处撒的微交互更有分量；过多动画反而是"AI 生成感"的来源。HTML 优先纯 CSS 方案；React 环境可用时用 Motion 库。
- **复杂度匹配愿景**：极繁方向要繁得到位，极简方向要在间距/排版/细节上精确。优雅=把选定的方向执行好。

## 6. 中文排版

- **字体栈**：正文 `"PingFang SC","Microsoft YaHei","Noto Sans SC",-apple-system,sans-serif`；衬线气质标题 `"Songti SC","Noto Serif SC",serif`。同时覆盖 Windows / macOS / Linux 常见字族并给兜底。
- **字重**：中文缺细腻字重梯度，别照搬拉丁"细体大标题"（小字号会糊）。用字号、字距、颜色对比建层级，而非 100/200 超细字重。
- **别用**：华康少女体、艺术字滤镜等"廉价感"字体；宁可用系统黑体的克制排版。
- **中英混排**：拉丁字体写在中文字族**前面**，中文才不会被拉丁字体的兜底字形接管。

---

# 硬规则与交付前预检（机械化，逐条核对）

> 下面每条都是"违反即返工"的硬规则。在擅长遵循明确指令的底座上，机械清单比纯理念更有效。

## 7. 硬规则（违反任意一条 = 交付了残次品）

**反默认纪律**——这些是 AI 套路，主动绕开：AI 紫/蓝光渐变、深色 mesh 上的居中 hero、三个等宽特性卡、到处玻璃拟态、无限循环微动画、Inter + slate-900。

**配色**
- 最多 1 个强调色，饱和度默认 <80%。**LILA 规则**：默认禁"AI 紫/蓝光"，用中性底（Zinc/Slate/Stone）+ 单一高对比强调（祖母绿/电蓝/深玫/焦橙）。品牌明确要紫再上。
- **一致性锁**：全页一个强调色，选定即锁，别第 7 屏突然冒个蓝 CTA。一个页面一套中性灰，别忽暖忽冷。用 CSS 变量固化，别散落硬编码色值。
- **高端消费配色禁令**（AI 第二高频破绽）：cookware/wellness/artisan/luxury 类别，默认禁"米色奶油底 + 黄铜/陶土/氧化红 + 浓缩咖啡近黑字"（`#f5f1ea`/`#b08947`/`#1a1714` 这类）。改用：冷奢银灰、森系深绿+骨白+琥珀、纯黑棕、钴蓝+奶油、陶土+石板灰、或纯单色+一个饱和亮点。品牌明确点名这些色才可用。

**布局**
- **Hero 必须落在首屏**：标题桌面 ≤2 行，副文 ≤20 词且 ≤3-4 行，CTA 不用滚动就可见。太长就缩字号或删文案。Hero 顶部内边距 ≤ `pt-24`（否则内容浮在半空像 bug）。**Hero 需要一个真实视觉**（文字+渐变块不算 hero）。
- **反居中偏见**：DESIGN_VARIANCE>4 时避免居中 hero，改左对齐/分栏(50/50)/左文右图/非对称留白。（编辑/宣言/发布公告类，居中 OK。）
- **导航单行**：桌面导航必须一行放下，放不下就精简或收进汉堡；高度 ≤80px。
- **同类版式不重复**：一种版式家族（三列卡/整宽引用/左文右图）全页最多出现一次；连续 ≥3 个"图文左右分栏"zigzag = 预检失败，用整宽/竖排/bento/marquee 打破。
- **眉标克制**（生产测试第 1 高频违规）：小号大写宽字距的 section 眉标（如 `SELECTED WORK`），**每 3 个 section 最多 1 个**；机械核对：数 `uppercase tracking` 类标签出现次数，超过 ⌈section 数/3⌉ 就砍。多数时候直接不要眉标，标题本身够了。
- **主题锁**：全页一个主题（明或暗），section 之间不反色。

**交互与无障碍**
- **按钮对比度自检**（a11y 必查）：白底白字、透明按钮无边框贴在图上——全禁。每个 CTA 过 WCAG AA（正文 4.5:1，大字 3:1）。
- **CTA 不换行**：主 CTA 文案 ≤3 词、桌面必须一行；换行=预检失败。**同意图 CTA 不重复**：全页"联系"类只用一个说法（别"联系我们"+"聊聊"+"开始项目"混用）。
- **完整状态**：加载用骨架屏（非转圈）、空状态可引导、错误就地说清、`:active` 给 `translateY(-1px)/scale(.98)` 触感。
- **表单**：label 在输入框上方，错误在下方，占位符绝不当 label。
- **键盘与动效偏好**：焦点态可见（别 `outline:none` 了事）；`prefers-reduced-motion: reduce` 下关掉位移与循环动画。

**内容密度与文案**
- 每个 section 默认：短标题(≤8 词)+短副段(≤25 词)+一个视觉或一个 CTA。
- **无数据倾泻**：20 行表/30 项清单/巨型价目表别塞进营销页，用 Top3-5+"查看全部"或换页。长清单(>5 项)换组件（分栏/卡片网格/tabs/横向 pill/carousel），别一根 `<ul>` 拉到底。
- **文案自审**（交付前逐条读所有可见文字）：删掉语法破碎的、指代不清的、像 AI 幻觉的俏皮双关、装深沉的伪谦逊。拿不准就换成一句平实功能句。
- **假精确数字禁令**：`92%`/`4.1×` 这类除非来自真实数据或明确标注为示例，否则禁——别伪造品牌没宣称的工程精度。

**图像**
- **禁 div 假截图**：`<div>` 拼的假仪表盘/假终端是明显 AI 破绽；要展示产品就用真截图/图生图/真实迷你组件，或干脆用编辑摄影。
- **即便极简站也需要 2-3 张真实图**，纯文字页不是极简、是没做完。素材获取走 §4 的顺序。
- **信誉墙**用真实 SVG logo（Simple Icons），别用纯文字 wordmark，且只放 logo、不加行业标签。

## 8. 文档型 HTML（报告/分析/白皮书——不是落地页时）

产出物是"给人读的文档"而非"营销页"时，营销页的旋钮基线不适用（改用 §2 表格末行），并补这几条：

- **版心**：`max-width: 76-88ch` 居中；正文 16-17px、行高 1.7-1.9；标题阶梯清晰（h1/h2/h3 字号+段前距拉开）。
- **结构件**：长文（>5 节）加粘性目录**或**顶部阅读进度条（二选一，别都上）。
- **表格**：表头强调色底或浅灰底 + 内线细浅灰 + 数字列右对齐 + >6 行斑马纹，**禁全黑粗网格**。
- **图表**：一律走 `dataviz` 技能，图表色与页面强调色同系；关键数字可做 stat 块但别通篇大数字卡。
- **打印友好**：正式报告补 `@media print`（隐藏导航/进度条、去背景色、表格与图表加 `break-inside: avoid`）——很多用户最终会"打印成 PDF"交差。
- §7 硬规则与 §9 预检**全部照常适用**（尤其：一个强调色、假精确数字禁令、截图自检）。

## 9. 交付前预检（跑一遍，任一失败就修）

**第一步永远是截图。** 溢出/错位/重叠/对比不足只有渲染出来才暴露。桌面与移动各截一次：

```bash
# macOS
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"   # 或 Microsoft Edge.app/Contents/MacOS/Microsoft Edge
# Linux
CHROME="$(command -v google-chrome || command -v chromium || command -v microsoft-edge)"
# Windows (Git Bash)
CHROME="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"

"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --window-size=1440,3000 --screenshot=check-desktop.png "file://$PWD/index.html"
"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --window-size=390,2400  --screenshot=check-mobile.png  "file://$PWD/index.html"
# 新版 Chrome 若报错，把 --headless 换成 --headless=new；环境有 playwright MCP 时优先用它。
```

逐条核对，全过才交付：

1. **渲染无缺陷**：桌面 + 移动两张图逐屏看，无溢出、错位、重叠、文字贴边。
2. **旋钮兑现**：VARIANCE/MOTION/DENSITY 三项与 §2 声明一致。
3. **锁与计数**：配色一致性锁 ✓ 主题锁 ✓ 眉标数 ≤ ⌈section 数/3⌉ ✓ 连续 zigzag <3 ✓ 同类版式不重复 ✓
4. **CTA**：每个都过 WCAG AA、桌面不换行、同意图不重复。
5. **Hero**：落在首屏、有真实视觉、顶部内边距不过大、标题 ≤2 行。
6. **文案与数据**：所有可见文字过了自审；无假精确数字；无 `div` 假截图；图片是真图或已标注兜底。
7. **中文与无障碍**：中文字体正常渲染无溢出；键盘焦点可见；`prefers-reduced-motion` 已尊重。
8. **交付物**：入口文件名为 `index.html`；CSS/JS 已内联（走 CDN 设计系统时，已在说明中告知需联网）。

## Restraint（收尾）

把大胆用在一个地方：让"签名元素"成为唯一记忆点，其余安静克制，砍掉不服务 brief 的装饰。Chanel 的话：出门前照镜子，摘掉一件配饰。
