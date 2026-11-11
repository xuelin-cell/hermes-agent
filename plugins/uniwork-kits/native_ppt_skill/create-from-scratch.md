
# 从零构建 PPT

Hermes普通主题创作和报告提炼沿用下文原生DSL逐页流程，用write-page一次完成当前页写入与检查，读取结果后再制作下一页。精确重建或原生带数据图表走host-tools指定的材料路径。批量仅在用户明确要求时按batch-experiment.md执行。

## 前置信息

### 目录结构

```markdown
<workspace_dir>/
├── <project_dir>/                  # 目录名 = pptx 文件名去后缀
│   ├── assets/                     # 静态资源
│   ├── slides/                     # DSL 源文件（每页一个 .slide）
│   │   ├── 01.slide
│   │   └── ...
│   └── <name>.pptx                 # 生成的演示文稿
```

命名约定：项目目录名与 pptx 文件名去后缀一致；页面文件 `{两位序号}.slide`；资源文件禁用中文、空格、特殊字符。

### CLI 工具

- slidep CLI：`create` / `lint` / `upsert-dsl`，完整参数见 [slidep-cli.md](references/cli/slidep-cli.md)（仅用于生成阶段，改稿走 [edit-existing](edit-existing.md)）

---

本流程适用于普通主题创作与报告内容提炼。精确还原截图、带编辑数据的图表和已有PPT修改先按host-tools.md选路，不叠加本流程的建稿与检查步骤。

## Step 1：需求对齐

确定主题、目标、受众、页数预期

**对话策略**：

- **只问缺失的**：能从上下文推断的直接采用，一轮问完，文字提问 ≤ 3 个
- **页数规则**：用户指定则以用户为准；给了逐页大纲则对齐其页数；只给主题时自行推测合理页数并说明理由
- **默认不打断**：非硬阻塞的空缺按合理默认推进，不反复向用户确认
- **意图未对齐 → 禁止进入后续任何步骤**，不许一边做一边猜

**产物**：以上 6 个维度全部有明确答案，作为 Step 2 及之后所有步骤的输入。

---

## Step 2：收集信息与素材

### 2.1 提取用户上传的材料(如果有)

### 2.2 联网搜索补充

当模型信息不足、数据过时或需要行业案例时，主动联网搜索。

**触发信号**：

- 主题涉及数字 / 市场 / 行业等时效性信息 → 需要最新数据
- 主题含陌生术语 → 先查清楚
- 用户要求"有说服力"但未提供素材 → 补充外部佐证

若用户已提供完整参考材料，本步可跳过或降级为只查陌生概念。

## Step 3：设计 PPT

### 3.1 风格路由（选 scenario）

从用户 query 中识别主题领域、目标受众、使用场合、调性倾向，与预设风格比对：

| 风格                                                     | 核心调性                       | 适用场景                                                                                                      |
| :------------------------------------------------------- | :----------------------------- | :------------------------------------------------------------------------------------------------------------ |
| [通用](references/scenarios/general.md)                   | 自由设计、按需推导             | 产品介绍、工作总结、技术分享、项目提案、述职报告等大多数场景                                                  |
| [学术风](references/scenarios/academic.md)                | 可信、证据驱动、蓝白克制       | 开题 / 中期 / 高校答辩、科研结题、文献综述、学术会议、临床/医学汇报（**不含教学课件**，授课讲义走通用） |
| [投资分析](references/scenarios/investment-analysis.md)   | 深度、严谨、证据留痕、假设透明 | 行业研究、公司深度、投研 deck、投委会汇报、券商研报、投资备忘录、IPO 路演、买方尽调、估值报告                 |
| [红金政务风](references/scenarios/redgold.md)             | 庄重、红金热烈、中文优先       | 党政机关汇报、国企央企汇报、党课/学习宣讲、表彰大会                                                           |
| [个人介绍](references/scenarios/personal-introduction.md) | 具体优于形容、张弛有度、有节奏 | 自我介绍（求职面试、职业交流、校园破冰、部门迎新）、介绍他人（人物分享、读书会、纪念专题）                    |

**判断标准**：用户场景是否**明确属于**上表某风格的特定领域。预设风格仅限垂直领域，产品介绍、工作总结、技术分享等通用场景走通用路线。

### 3.2 构建叙事与视觉（DESIGN.md）

1. **阅读 3.1 选定的 scenario 文件**，吸收该场景的配色 / 字体 / 布局候选 / 独有风格。
2. **一定要阅读 `references/design-principle.md`**，掌握通用的结构原则、写作原则、禁令、叙事骨架、字段表，构建 `DESIGN.md`——综合 Step 1 对齐的 6 个维度 + scenario 的具体视觉选项 + design-principle 的通用框架。

---

## Step 4：创建空白 PPTX 并打开预览

1. 运行 `slidep create "<project_dir>/<filename>.pptx"` 创建空白文件
   - 文件名默认中文（如 `"季度汇报.pptx"`），用户明确要求英文时才用英文
2. Hermes的 TencentPpt create 会自动显示“制作中·草稿”文件卡片，用户可以打开当前稿件预览。
   - 不额外调用 present_files / PresentToUser，不将草稿称为完成或最终交付。
   - 预览面向用户，Agent 不读取、不截图、不导出页面，也不依据用户预览做视觉核对。

---

## Step 5：逐页生成 PPT

按大纲顺序从第 1 页到第 N 页，每页闭环：**配图(如果有) → 写源文件 → 写入并检查 → 读取回执**。

### SlideDSL 与组件

每页是一个 `.slide` 文件，使用受限的 JSX DSL，直接编译成 OOXML（.pptx）。把它当 HTML + 内联 CSS 来写，禁止 React 生态概念（`import` / `export` / hooks / state），文件最后一个表达式必须是 `<Slide>`。

动笔前按需阅读本页用到的组件文档（`references/dsl/*.md`）：

| 组件                                    | 用途                |
| --------------------------------------- | ------------------- |
| [Slide](references/dsl/slide.md)         | 页面根容器          |
| [Box](references/dsl/box.md)             | 布局容器（Flexbox） |
| [Text](references/dsl/text.md)           | 文字内容            |
| [Image](references/dsl/image.md)         | 位图 / 照片         |
| [SVG](references/dsl/svg.md)             | 内联矢量图          |
| [Chart](references/dsl/chart.md)         | 图表                |
| [Table](references/dsl/table.md)         | 表格                |
| [FAIcon](references/dsl/faicon.md)       | Font Awesome 图标   |
| [CodeBlock](references/dsl/codeblock.md) | 代码块              |
| [Math](references/dsl/math.md)           | 数学公式            |
| [QRCode](references/dsl/qrcode.md)       | 二维码              |
| [Hyperlink](references/dsl/hyperlink.md) | 超链接              |
| [Animation](references/dsl/animation.md) | 入场/退出/强调动画  |
| [Diagram](references/dsl/diagram.md)     | 流程图/架构图路由   |

### 每页流程

Hermes普通创作沿用本版WorkBuddy逐页闭环：每页使用write-page在一次工具调用内完成upsert-dsl→lint，模型读取结果，修复当前页后再生成下一页。不要重复单独lint。只有用户明确要求批量或对照实验时才按batch-experiment.md执行，不默认提前生成多页。

1. **配图前置**：每页动笔前准备本页尚未具备的素材，按 [宿主素材规则](host-tools.md) 使用用户图片、真实搜图或创意生图。已准备并核对的素材直接复用，不为每页重复生图或识图。只核对素材文件本身，此处不检查 PPT 页面或渲染结果。
2. **写入页面源文件**：write_file 到 `slides/{NN}.slide`
3. **写入与检查只走宿主入口**：使用 `TencentPpt(action="write-page", file_path=工作稿, dsl_file=当前页源文件)`。新页省略 page_index，宿主在一次调用内依次 upsert→lint；不要另外执行 CLI、单独 lint 或自行解包复检。
4. **按回执决定下一步**：
   - `ok:true`：当前页完成，继续下一页。
   - `ok:false`：读取 `failed_phase`、`diagnostics` / `failures` 和 `page_index`，修复当前页。已写入的页必须带返回的原 page_index 重试，不能作为新页追加。没有获得有效页号时，按失败回执恢复，不自行猜下标。
   - 总页数使用 `presentation.written_pages`，通过页数使用 `presentation.checked_pages`；lint 的 `slide_count` 不是整份 PPT 的页数。
5. **检查不另开一套流程**：内容、数字、事实与建议在写源文件时核对；布局按宿主诊断修复。不要临时写正则/解包脚本、创建探测 PPT，或在通过后仅凭猜测反复调整版式。用户明确提出修改，或发现具体内容错误时，只修受影响页；材料重建的原图核对仍按材料路线执行。

## Step 6：结束

Step5完成所有页生成和原生lint后，调用 TencentPpt(action="finalize", file_path=工作稿路径)。该调用直接使用已有检查结果保存独立最终版本，并交付文件。成功回执后再向用户说明完成。不要再额外复检或截图，也不要单独调用PresentToUser。


# DSL路线的严格约束

- 在 TODO / 进度汇报中**必须使用用户术语**（内容大纲 / 风格设计 / 创建演示文稿 / 逐页制作 / 交付），**禁止暴露内部实现**（`JSX`、`DSL`、`slidep`、`lint`、`upsert-dsl`、`OOXML` 等）。沟通统一用「页 / 封面 / 目录 / 这一页」。
- DSL路线按原生布局诊断修复；不要宣称结构检查等同于视觉检查，也不临时另建外部渲染链。自由pages JSON路线使用宿主返回的真实预览核对。
- 本生成流程已经在逐页生成过程，每页均进行严格核查，禁止生成中或者生成完成后通过各种方式进行复检。
