# 出稿套件 pptkit（写 slides.js 只需要看这一份）

> **核心思想：你负责给数据，坐标/字号/图层/间距全部由 `<技能根>/scripts/pptkit.js` 负责。**
> 你**不要**自己算 x/y/w/h，也**不要**自己定字号——手算坐标是「文字溢出 / 怪换行 / 元素重叠 / 三张卡三个字号」的唯一来源。

## 🔑 区块数据键名速查（**写错一个字 = 整块不画**）

pptkit 的每个区块吃的键名**各不相同**，凭直觉全写 `items` 是最常见的事故。
**里层字段名同样不能凭直觉**：写错了渲染器取到 undefined，页面上会直接印出 `undefined` 五个字母（比如 `statStrip` 写成 `{v,k}`）。
键名写错时 pptkit 会报 `✗ 内容缺失` 并**拒绝出稿**，照报错改键名即可。

| 区块 | 必需键 | 最小调用 |
| --- | --- | --- |
| `featureRow` | `items` | `featureRow(s, { a, items:[{title,lines}] })` |
| `statRow` | `items` | `statRow(s, { a, items:[{value,label}] })` |
| `statStrip` | `items` | `statStrip(s, { a, items:[{value,label}] })` |
| `barsBlock` | `items` | `barsBlock(s, { a, items:[{name,v,label}] })` |
| `kvGrid` | `items` | `kvGrid(s, { a, items:[{k,v}] })` |
| `numberList` | `items` | `numberList(s, { a, items:[{title,text}] })` |
| `photoGrid` | `items` | `photoGrid(s, { a, items:[{img,caption}] })` |
| `bulletBlock` | **`lines`** | `bulletBlock(s, { a, lines:[…] })` |
| `timelineRow` | **`steps`** | `timelineRow(s, { a, steps:[{t,d}] })` |
| `processRow` | **`steps`** | `processRow(s, { a, steps:[{t,d}] })` |
| `layersBlock` | **`layers`** | `layersBlock(s, { a, layers:[{title,tags}] })` |
| `matrixBlock` | **`quadrants`** | `matrixBlock(s, { a, quadrants:[…4 项…] })` |
| `tableBlock` | **`head`+`rows`** | `tableBlock(s, { a, head:[…], rows:[[…]] })` |
| `compareRow` | **`left`/`right`**（各带 `lines`） | `compareRow(s, { a, left:{title,lines}, right:{title,lines} })` |
| `quoteBlock` | **`text`** | `quoteBlock(s, { a, text:"…", by:"…" })` |
| `calloutBlock` | **`text`** | `calloutBlock(s, { a, text:"…" })` |
| `imageBlock` | **`img`** | `imageBlock(s, { a, img:"./img/x.jpg" })` |
| `chartBlock` | **`data`** | `chartBlock(s, { a, type, data:[…] })` |

`compose` / `page.free` 里的**块名**又是另一套（`cards` / `stats` / `flow` / `numbers` / `kv` / `photos` /
`bullets` / `compare` / `timeline` / `quote` / `table` / `callout` / `layers` / `matrix` / `image` /
`bars` / `chart` / `statStrip`）—— 拼错块名同样整块不画，同样会被拒绝出稿。

`tocSlide` 必须给 `chapters`，否则目录页只剩页眉。

## 0. 起手式（照抄，两条命令 + 六行代码）

```bash
cp <技能根目录>/<技能根>/scripts/pptkit.js ./pptkit.js        # 必须，和 slides.js 同级
node <技能根目录>/<技能根>/scripts/theme_generator.js <技能根目录>/themes/xxx.json ./theme.js
```

```javascript
const pptxgen = require("pptxgenjs");
const THEME   = require("./theme.js");
let pres = new pptxgen();
pres.layout = "LAYOUT_16x9";                       // 联通模板见 unicom-template.md
const K = require("./pptkit.js")(pres, THEME);     // ← 必须！删了就会字超框
const { page, coverSlide, tocSlide, sectionSlide, contentSlide, closingSlide,
        rowsOf, colsOf, padOf, featureRow, statRow, timelineRow, processRow,
        compareRow, barsBlock, chartBlock, imageBlock, quoteBlock, bulletBlock,
        layersBlock, matrixBlock, charts } = K;

// === SLIDES START ===
// === SLIDES END ===

pres.writeFile({ fileName: "output.pptx" }).then(() => console.log("done"));
```

`node slides.js` 每次都会打印体检结果：
- `[pptkit] ✅ 体检通过` → 继续下一页
- `[pptkit] ⚠ 排版问题 N 处` → **必须先改掉再继续**（下面「体检报警怎么修」有对照表）

---

## 1. 整页配方 `page.*`（**内容页默认走这里**）

> **两条合法路径，按需要选：**
> - **`page.*` 配方**（本节）——快、稳、比例已调好。适合结构清晰的标准页。
> - **`page.free` 自由拼版**（第 1.5 节）——**要密度、要变化时用它**，2–4 个块自由组合，高度由引擎算。
>
> 🔴 **唯一的硬规则：不许手写 x/y 坐标。** 这两条路都不需要你算坐标。
> （自己 `rowsOf` 切区域是允许的兜底，但最容易翻车：给排行条/图表分到的高度不够，条目被压成 8pt 小字。）
>
> **一份 deck 里两种路径混着用最好**：标准页走配方，重点页（总览/数据/结论）走 `page.free` 做高密度。

```javascript
const { page } = K;

page.cards({ kicker:"CAPABILITY", title:"三层能力体系成型，应用层贡献过半价值", pageNo:4, note:"讲稿一句话",
  cols:3, items:[
    { icon:"1", title:"基础层", lines:["智算中心超 80 座","国产芯片份额 35%"] },
    { icon:"2", title:"技术层", lines:["备案大模型超 300 个","多模态成为主流"] },
    { icon:"3", title:"应用层", lines:["行业渗透率达 58%","贡献产值超 6000 亿"], hero:true },  // hero=品牌色卡，做视觉锚点
  ]});

page.kpiChart({ kicker:"MARKET", title:"产业规模达 2.1 万亿，智算占比 42%", pageNo:3,
  kpis:[{value:"2.1万亿",label:"产业总规模"},{value:"42%",label:"智算占比"},{value:"33%",label:"三年复合增长"}],
  chartTitle:"规模走势（万亿元）", chartType:charts.BAR, chartOpts:{ barDir:"col" },
  chartData:[{ name:"规模", labels:["2023","2024","2025","2026E"], values:[0.6,0.8,1.0,1.2] }] });

page.kpiBars({ title:"三大集群集聚全国 78% 智算资源", pageNo:5,
  kpis:[…], barsTitle:"区域分布", bars:[{name:"京津冀",v:34,label:"34%"}, …] });

page.compare({ title:"转型前后对比", pageNo:6, kpis:[…]/*可选*/,
  left:{ title:"转型前", lines:[…] }, right:{ title:"转型后", lines:[…] } });   // 右侧=目标态，会用品牌色

page.flow({ title:"落地路径：从试点走向规模化", pageNo:7,
  steps:[{t:"夯基",d:"数据治理"},{t:"试点",d:"标杆验证"},{t:"推广",d:"规模复制"}],
  bullets:["设立专项基金","共建行业底座"], bulletsTitle:"行动建议" });   // 或 items:[…] 或 chartData:[…]

page.timeline({ title:"六年跨越三大阶段", pageNo:8,
  steps:[{t:"2023",d:"政策出台"},{t:"2024",d:"规模落地"},{t:"2025",d:"生态成熟"}],
  left:{title:"已完成",lines:[…]}, right:{title:"进行中",lines:[…]} });

page.split({ title:"投入与产出", pageNo:9,
  left:{ title:"投入结构", bars:[{name:"算力",v:60,label:"60%"}, …] },
  right:{ title:"关键举措", lines:["…","…"] } });

page.layers({ title:"四层技术底座支撑全域智能化", pageNo:10, layers:[      // 分层架构图
  { title:"应用层", tags:["智能客服","研发提效","风控决策"] },
  { title:"模型层", tags:["通用大模型","行业模型","端侧小模型"] },
  { title:"平台层", tags:["训练平台","推理服务","数据治理"] },
  { title:"算力层", tags:["智算中心","国产芯片","统一调度"] },
]});

page.matrix({ title:"场景优先级：先做高价值高可行的右上角", pageNo:11,   // 2×2 象限
  xLabel:"落地可行性 →", yLabel:"业务价值 →", quadrants:[               // 顺序=左上/右上/左下/右下
    { title:"战略储备", lines:["具身智能试点"] },
    { title:"优先投入", lines:["智能客服","风控决策"], hero:true },
    { title:"暂缓",     lines:["泛娱乐生成"] },
    { title:"快赢补位", lines:["文档摘要","会议纪要"] },
  ]});

page.quote({ title:"结论", pageNo:12, text:"一句观点。", by:"出处" });
```

**有真实照片时**（旅游/文旅/产品/案例类必备，图必须先下载到本地）：

```javascript
// 整幅实景封面：自带压暗遮罩与渐变带，图再亮白字也压得住
coverSlide({ photo:"./img/cover.jpg", kicker:"XINJIANG 2026",
             title:"一路向西：新疆全景深度游", sub:"14 天自驾路书", org:"XX 文旅", date:"2026 年 7 月" });

// 照片页：整幅图 + 图上文字，比"半图半字"有气势
page.photo({ img:"./img/kanas.jpg", kicker:"NORTH", title:"北疆：草原、雪山与湖泊", pageNo:3,
             lines:["喀纳斯湖：晨雾与神仙湾，建议住宿两晚","禾木村：清晨炊烟是全疆最出片的机位"] });

// 照片墙：page.free 里放 photos 块
page.free({ title:"六大必去点位", pageNo:4, blocks:[
  { photos:{ cols:3, items:[ {img:"./img/a.jpg", caption:"喀纳斯湖 · 神仙湾"}, … ] } },
  { callout:{ label:"建议", text:"北疆重风光、南疆重人文，14 天建议 8:6 分配。" } } ]});
```

> 图片路径**必须是已下载到本地的文件**。写网址、或搜到没下载就引用 → 引擎会画占位块并告警（不会炸掉整份稿，但那一格就是空的）。
> 图从哪来、怎么验收，见 skill.md 的「🖼 配图规则」——**默认搜真图，不要张口就生图**。

还有 3 个**结构性**页型，用来打破"每页都长一样"的节奏（这是"像小学生 PPT"的头号原因）：

```javascript
// 整幅品牌色 + 一句大字主张：连续几页浅色内容页之后用它换口气
page.statement({ kicker:"KEY INSIGHT", title:"增量不再来自堆算力，而来自单位算力的转化效率",
                 text:"2026 年是价值兑现元年：推理侧支出首次超过训练侧。" });

// 半页大数字 + 右侧论证：单点结论最有冲击力的表达
page.bigNumber({ kicker:"HEADLINE", title:"智算占比首次突破四成", pageNo:6,
  value:"42%", label:"智算占算力总规模比例",
  blocks:[ { bullets:{ lines:["新增采购中国产芯片占 47%","推理集群规模同比增 2.8 倍"] } },
           { callout:{ label:"含义", text:"算力结构切换已经完成，竞争转入应用层。" } } ] });

// 左侧色块面板放论点 + 右侧自由拼版放证据：咨询稿最常用的版式
page.panel({ kicker:"DIAGNOSIS", title:"三个结构性矛盾制约规模化", pageNo:7,
  panel:{ title:"核心判断", lines:["数据供给跟不上模型迭代","场景 ROI 缺乏统一口径","复合型人才缺口最大"] },
  blocks:[ { table:{ head:["矛盾","影响面","缓解周期"], rows:[["数据","68%","12 个月"],["ROI","54%","6 个月"]] } },
           { callout:{ text:"先解决口径问题，再谈规模复制。" } } ] });
```

> **每份 deck 至少放 1 张"图示型"页**（`page.layers` / `page.matrix`）**和 1 张"结构性"页**
> （`page.statement` / `page.bigNumber` / `page.panel`）。全篇都是"文字块 + 条形图"是与商用稿差距最大的一点。

所有 `page.*` 与 `contentSlide` 都支持这几个通用参数（能加就加，商用感就是这些细节堆出来的）：

| 参数 | 作用 |
| --- | --- |
| `kicker` | 页眉品牌色小胶囊，写英文栏目名（≤14 字符） |
| `pageNo` / `of` | 页码，给了 `of` 就显示 `04 / 12` |
| `chapter` | 页眉右侧章节指示，如 `"02 · 三层能力体系"` |
| `source` | 页脚数据出处，如 `"数据来源：IDC《中国AI市场追踪》2026Q2"` |
| `note` | 演讲者讲稿（1–2 句，写进备注） |

> 配方覆盖不了的特殊版面，才用下面第 2–4 节自己拼。

## 1.5 自由拼版 `page.free` / `compose`（**要密度、要变化时用这个**）

配方 `page.*` 管**稳**，自由拼版管**密度和变化**。你只描述「这页有哪些块、谁上谁下、谁跟谁并排」，
**每块要多高由引擎按内容量算，剩余空间按 `flex` 分配**——所以既不会重叠越界，也不会被固定成一个模子。

```javascript
page.free({ kicker:"MARKET", title:"产业规模达 2.1 万亿，智算贡献四成增量", pageNo:4, of:9,
  chapter:"01 · 产业总览", source:"数据来源：课题组测算（2026Q2）", blocks:[

  { statStrip:{ items:[                       // 紧凑 KPI 条：一行 3–6 个数字，比 statRow 省一半高度
      {value:"2.1万亿",label:"产业总规模"}, {value:"42%",label:"智算占比"},
      {value:"33%",label:"三年复合增长"},   {value:"6800亿",label:"大模型营收"}] } },

  { row:[                                      // 并排：flex 决定谁宽
      { chart:{ title:"规模走势（万亿元）", type:charts.BAR, opts:{barDir:"col"},
                data:[{name:"规模",labels:["2023","2024","2025","2026E"],values:[0.62,0.98,1.52,2.10]}] }, flex:1.25 },
      { bullets:{ title:"三个结构性变化", lines:["…","…","…","…"] } } ] },

  { callout:{ label:"结论", text:"增量不再来自堆算力，而来自单位算力的商业转化效率。" } },
]});
```

**可用块**（写在 `blocks` 里，键名就是块名）：

| 块 | 用途 | 主要参数 |
| --- | --- | --- |
| `statStrip` | 紧凑 KPI 条（**高密度首选**，一行 3–6 个数字） | `items:[{value,label}]` |
| `stats` | 大 KPI 卡片排（气势足但占高度） | `items:[{value,label}]` |
| `table` | **表格**——商用稿密度最高的块 | `head:[…], rows:[[…]], widths:[…], strongCol, align:"right"` |
| `kv` | 键值网格（参数表/指标清单，2–3 列密排） | `items:[{k,v}], cols` |
| `numbers` | 编号要点（大号数字 + 标题 + 说明） | `items:[{title,text}]` |
| `callout` | 结论条（品牌色横条，给一页收口） | `label, text` |
| `cards` | 特性卡阵 | `items:[{icon,title,lines,hero}], cols` |
| `bullets` | 要点卡（≥4 条自动分两列） | `title, lines` |
| `bars` | 排行条 | `title, items:[{name,v,label}]` |

### 复刻用户上传的模板：`K.setFrame(fn)`

```js
K.setFrame(function (s, o) {   // o: {title, kicker, chapterNo, pageNo, of, chapter, ...}
  /* 画模板每页都有的框：侧栏 / 顶部色带 / 页眉页脚 / 编号 / logo */
  return { x: 0.55, y: 1.15, w: 8.9, h: 3.75 };   // ← 必须返回正文可用区
});
```

注册一次即可，之后 `contentSlide` 和所有 `page.*` 都用你的框和你返回的正文区，
正文照旧享受自动分高 / 防溢出 / 字号统一 / 排版体检。只在**复刻上传模板**时用
（详见 [custom-template.md](custom-template.md)）；从零做稿不要用，内置页眉就挺好。
| `chart` | 图表 | `title, type, data, opts` |
| `compare` | 左右对比 | `left:{title,lines}, right:{…}` |
| `flow` / `timeline` | 流程 / 历程 | `steps:[{t,d}]` |
| `layers` / `matrix` | 分层架构 / 2×2 象限 | `layers:[…]` / `quadrants:[…]` |
| `quote` | 金句 | `text, by` |
| `row` | 把若干块并排 | `row:[块…]`，每块可给 `flex` |

规则：`flex` 只影响**富余空间怎么分**（不给就均分）；`h:1.2` 可以钉死某块的高度（少用）。

**给每页立一个"主角"**：商用稿的每一页都有一个占 45%–55% 版面的主体（一张大表、一个大图表、一个矩阵），
其余是配角。做法就是给主角 `flex:2`：
```javascript
blocks:[ { statStrip:{…} }, { table:{…}, flex:2 }, { callout:{…} } ]
```
**别让一页里三个块权重一样大**——那正是"每页长得都一样"的根源。

**语义色**（一眼看出好坏，别让涨跌和普通数字同色）：
```javascript
{ kv:{ items:[ {k:"营收同比", v:"+38%", tone:"up"}, {k:"坏账率", v:"-0.4pp", tone:"down"} ] } }
{ statStrip:{ items:[ {value:"+62%", label:"增速", tone:"up"} ] } }
```
表格里以 `+ / ↑` 开头的单元格会**自动**变绿、`- / ↓` 自动变红，不用手动标。

## 2. 五种页型（一行一页）

```javascript
coverSlide({ kicker:"White Paper 2026", title:"主标题", sub:"副标题一句话",
             org:"主办单位", date:"2026年7月", motif:"rings" });   // motif: rings|band|dots

tocSlide({ chapters:["第一章标题","第二章标题","第三章标题","第四章标题"] });

sectionSlide({ no:1, title:"章节标题", sub:"SECTION KICKER" });

const { s, a } = contentSlide({ kicker:"MARKET SIZE", title:"页标题（观点句）",
                                pageNo:4, note:"1-2 句讲稿" });
// s = 这一页；a = 版心区域（页眉之下的可用矩形），下面所有区块都往 a 里放

closingSlide({ title:"谢谢观看", sub:"Thank You", org:"主办单位", date:"2026年7月" });
```

## 3. 把版心 `a` 切成区域（唯一允许的"布局计算"）

```javascript
const [top, bot]   = rowsOf(a, [1, 1.6]);   // 上下切两带，比例 1:1.6，间距已自动留
const [l, r]       = colsOf(bot, 2);        // 左右等分两列
const [c1, c2, c3] = colsOf(a, 3);          // 三列
const inner        = padOf(a, 0.3);         // 整体内缩
```

> ⚠️ **除了 `rowsOf/colsOf/padOf`，不要出现任何手写的 x/y 数字。** 需要什么形状就找下面的区块，没有合适的再用 `K.card(s, rect)` 画底、再往里放东西。

## 4. 内容区块（每个都吃一个区域 `a`，自己算内部一切）

| 用途 | 调用 |
| --- | --- |
| 并列能力/要点卡（**一排 2–4 张**，超过就拆两排：`cols:3` + 6 项 = 3×2 网格） | `featureRow(s, { a, cols:3, items:[{icon:"1", title:"卡标题", lines:["要点一","要点二"], hero:true}, …] })` |
| 核心数字 KPI（3 个最佳，最多 4 个） | `statRow(s, { a, items:[{value:"2.1万亿", label:"产业总规模"}, …] })` |
| 发展历程 / 阶段 | `timelineRow(s, { a, steps:[{t:"2024", d:"一句话"}, …] })` |
| 流程 / 步骤链路（3–5 步） | `processRow(s, { a, steps:[{t:"数据治理", d:"一句话"}, …] })` |
| 前后对比 / A vs B | `compareRow(s, { a, left:{title:"转型前", lines:[…]}, right:{title:"转型后", lines:[…]} })` |
| Top-N 排行 / 份额（纯形状，永不失败） | `barsBlock(s, { a, title:"可选小标题", items:[{name:"华东", v:120, label:"120"}, …] })` |
| 图表 | `chartBlock(s, { a, title:"可选", type:charts.BAR, data:[…], opts:{barDir:"col"} })`<br>柱状图加 `opts:{barDir:"col"}`；多系列加 `opts:{showLegend:true, legendPos:"b"}`<br>**饼图**：`opts:{showPercent:true}`，至少 2 个分类，且**区域必须高 ≥1.9"**（饼的直径吃高度）——扁区域里的饼会小得看不清，这种场合请改用 `barsBlock` 展示占比 |
| 左图右文（图必须已下载到本地） | `imageBlock(s, { a, img:"./img/x.jpg", title:"标题", lines:[…], caption:"图注", side:"right" })`<br>区域窄时会自动改成"上图下文" |
| 照片墙（2–6 张，等分网格 + 图注） | `photoGrid(s, { a, cols:3, items:[{img:"./img/a.jpg", caption:"喀纳斯湖 · 神仙湾"}, …] })` |
| 金句 / 结论 | `quoteBlock(s, { a, text:"一句话观点", by:"出处" })` |
| 普通要点卡 | `bulletBlock(s, { a, title:"小标题", lines:[…] })` |

**一页 = 页眉 + 1～2 个区块。**
- 只放**一个**区块时，选能撑满版心的：`featureRow` / `barsBlock` / `compareRow` / `chartBlock` / `quoteBlock`。
- `statRow` / `timelineRow` / `processRow` 有固定的最佳高度，**必须再配一个区块**（否则页面会空一大半）。

典型写法：

```javascript
{
  const { s, a } = contentSlide({ kicker:"Market", title:"产业规模突破 2.1 万亿，智算占比达 42%", pageNo:4, note:"先给总量。" });
  const [top, bot] = rowsOf(a, [1, 1.7]);
  statRow(s, { a: top, items:[
    { value:"2.1万亿", label:"产业总规模" },
    { value:"42%",     label:"智算占比" },
    { value:"35.6%",   label:"年复合增长" },
  ]});
  chartBlock(s, { a: bot, type: charts.BAR, data:[{ name:"规模", labels:["2024","2025","2026"], values:[1.2,1.6,2.1] }], opts:{ barDir:"col" } });
}
```

## 4.5 信息密度目标（**这一条决定成品像商用稿还是像小学生 PPT**）

不出错只是及格线。**空、稀、每页就三句话 = 廉价**。商用稿的密度长这样：

| 指标 | 目标 | 说明 |
| --- | --- | --- |
| 每张内容页的**块数** | **默认 2 个；只有当其中一个是 `statStrip`/`callout` 这种矮块时才放 3 个** | 16:9 的版心只有约 3.7"：两个中等块（各 ~1.7"）刚好；三个中等块必被压成小字 |
| 每张内容页的**信息单元** | **≥12 个**（一个数字/一条要点/一个表格单元格各算一个） | |
| 版心利用率 | **55%–75%** | 低于 45% 太空，高于 80% 太挤 |

### 🔑 密度靠"块的数量"，**绝不是**靠把每条要点写长

这是最容易搞反的一点。**每块内部的文案预算（第 5 节）一个字都不能放宽**——
放宽的结果是引擎把字号一路收到 9pt，页面反而更难看。正确做法是**同样短的文案，多摆几块**：

```
一页 ≈ statStrip(4 个数字，约 40 字)
     + row[ chart + bullets(4 条 ×16 字，约 70 字) ]
     + callout(一句结论，约 30 字)
     ≈ 12+ 个信息单元 —— 密度就上去了，而每一块都还在预算内
```

提密度的手段（按性价比排序）：
1. **`page.free` 拼 2–3 个块**，而不是一页一个配方。
2. **上表格**（`table`）——同样的面积，表格能装 3–5 倍信息；行数 ≤6。
3. **KPI 用 `statStrip` 而不是 `stats`**：省一半高度，省出来的地方再放一个块。
4. **要点带数字**：写"推理侧支出首次超训练侧，占比 54%"，不写"降本增效"这种空词。**长度不变，信息量翻倍。**
5. **每页配 `callout` 收口**：一句结论，既提升说服力又填掉底部空白。
6. 用 `source` 写数据出处、`chapter` 写章节指示。

> ⚠️ 看到 `⚠ 本页放不下这 N 个块` → **拆成两页**，不要硬塞。
> 看到大量 `文案过长` → 是你把某一块的文案写超了，回去按第 5 节压，不是去调区域。

## 5. 文案预算（超了就会被自动缩字号，字一小就难看）

| 位置 | 上限 | 说明 |
| --- | --- | --- |
| 页标题 | **≤20 字** | 写**观点句**：结论 + 数字（"智算占比达 42%"），不写名词短语（"算力基建"❌） |
| kicker | ≤14 字符 | 全英文小字 |
| 卡标题 `title` | **≤8 字** | |
| 卡要点 `lines` | **每条 ≤14 字，每卡 ≤4 条** | |
| KPI `value` | **≤5 字符** | `2.1万亿` `42%` `300+`；再长就没有大数字的冲击力 |
| KPI `label` | **≤10 字** | |
| 时间线/流程 `t` | ≤5 字；`d` ≤12 字 | |
| `barsBlock` | 每条约需 **0.30" 高** | 5 条就给它 ≥1.8" 的区域，否则字号会被压小 |
| `timelineRow` / `processRow` | **3–5 个节点**；`t` ≤5 字，`d` **≤12 字且只能是一句话** | 别把好几条要点塞进一个 `d`（"金融：68% 智能风控 制造：..."❌），那是 `featureRow`/`bulletBlock` 的活 |
| `statStrip` | **3–4 个**（不是 5–6 个）；`label` **≤6 字** | 5 个以上列宽不够，标签必然折行被压小 |
| `table` | **≤5 行 ×4 列**；单元格 ≤8 字 | 6 行以上就该换成两张表或换 `kv` |
| `kv` | **≤6 项**；`k` ≤6 字、`v` ≤8 字 | |
| `numbers` | **≤3 条**；`title` ≤10 字、`text` ≤20 字 | 4 条以上每条就没高度了 |
| `callout` | `text` **≤32 字**，一句话 | 它是结论，不是段落 |
| `coverSlide.title` | **≤16 字**；更长就自己用 `\n` 断在词与词之间 | 封面是第一印象，自动断行可能把词劈开（"人工\|智能"） |
| `tocSlide.chapters` | 3–8 章，每章 **≤14 字**；>5 章自动分两栏 | |
| `page.matrix` 每象限 `lines` | **≤3 条，每条 ≤10 字** | 象限卡本来就小 |
| `page.layers` 每层 `tags` | **≤4 个，每个 ≤8 字** | 标签是并排的，多了会挤 |
| `page.flow` 的 `bullets` | **4–6 条**（会自动分两列） | 少于 4 条卡片会显得空 |
| `page.cards` 的 `items` | **一排 2–4 张**；6 张写 `cols:3` 排成两排 | |

### 文案放不下时怎么办（按优先级）
1. **精简文案** —— 90% 的情况都该这么办，商用 deck 本来就要短。
2. **换区块**：多条并列信息 → `featureRow` / `bulletBlock`；一堆数字 → `statRow` + `barsBlock`；长论述 → `quoteBlock`。
3. **调大区域**：改 `rowsOf` 的比例，或把这一页拆成两页。
4. ❌ 不要靠"让它自己缩小字号"硬塞 —— 缩到 8pt 就没人看得清了，体检会报 `文案过长`。

**量纲自洽**：KPI 的数值和标签必须对得上——增速/占比带 `%`，规模带 `亿/万亿`（"1500万+" 配"同比增速"是硬伤）。
**中英混排别用 `/` 连接**（写「手机、PC、汽车」而不是「手机/PC/汽车」），渲染器会在中英边界插入不对称空格。

> **最强的 3 个数字必须做成 `statRow`**，不要埋在正文里。每页都写 `note:` 讲稿。

## 6. 体检报警怎么修

| 报警 | 含义 | 改法 |
| --- | --- | --- |
| `自动收字号 N 处` | **不是报警**，是告诉你有 N 处文字被自动缩过 | N 很小（≤5）不用管；N 突然变大说明你刚加的那页文案超预算了，回去精简 |
| `文案过长(字号被迫 14→9pt)` | 这块文字放不下 | 按第 5 节精简文案，或把它所在的区域调大（改 `rowsOf` 比例） |
| ⚠️ **用 `page.*` 配方的页收到报警** | 配方不暴露版面旋钮 | **只能精简文案，或换一个配方**。**绝对不要**为此改成手写坐标——那会把溢出/重叠全带回来 |
| `越界` | 元素跑出画布 | 你手写坐标了——改用 `rowsOf/colsOf` |
| `色块交叉重叠` / `文字互相压盖` | 两个区块占了同一块地 | 同一个 `a` 被喂给了两个区块；先 `rowsOf` 切开再分别喂 |
| `文字探出卡片` | 文字框比卡片大 | 别手搓卡片，用区块 |
| `图层错(内容被盖成空白卡)` | 色块画在文字之后 | 先 `K.card()` 画底，再放内容；或直接用区块 |
| `barsBlock 区域偏矮` | 条目太多、区域太矮 | 减条目或调大区域 |

## 7. 视觉纪律（决定"惊艳"与否）

1. **组件轮换**：相邻两张内容页不得用同一个主区块。推荐轮换序
   `featureRow → statRow+chartBlock → timelineRow/processRow → compareRow → barsBlock/imageBlock`。
2. **三明治节奏**：封面/章节页/结束页深色（联通为红/白），内容页浅色。
3. **每页至少 2 种视觉元素**（卡片、图表、条形、图标圈、chevron 都算）。纯文字页只允许 `quoteBlock`。
4. **配色只用 THEME**：区块内部已全部走 `THEME.colors`，你不需要也不应该硬编码颜色。
5. **绝不**在标题下加装饰横线；正文左对齐；中文引号会让 pptxgenjs 崩溃，只用 ASCII 引号。

## 8. 需要自定义时（少用）

```javascript
K.card(s, { x, y, w, h });                 // 只画卡底（先画底，再放内容！）
K.coverDecor(s, "band");                   // 纯形状装饰母题
s.addText("...", { x, y, w, h, fontFace: THEME.fonts.title, fontSize: 20, margin: 0 });
```
自己写 `addText` 时**必须给 `w` 和 `h`**——pptkit 靠这两个值反算字号；不给 `h` 就只能按单行保护，多行文字会失去保护。
