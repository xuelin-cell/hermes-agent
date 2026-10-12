# 🔴 中国联通品牌模板（命中即最高优先）

> 触发词：`联通` `中国联通` `联通模板` `联通风格` `联通PPT` `联通数智` `数智PPT` `联通元景` `元景`，
> 以及「联通 + 任意风格词」（联通科技风 / 婉约风 / 简约风 / 商务风 …）。命中就走本文，**不要**再去 `<技能根>/themes/` 做普通匹配。

品牌页型已经全部内建在 `<技能根>/scripts/pptkit.js` 的 `brand:"unicom"` 里（坐标逐页实测自源模板
`数智公司PPT模版-联通元景新logo`），你只需要给数据。

## 六条铁律

1. **页序固定**：封面第 1 → 目录第 2 → 中间内容/章节 → **结束页永远最后一张**。
2. **封面/结束页禁背景图与 AI 生图**：联通封面就是纯白底 + 红标题 + 双 logo + 左红条。**不要** `background:{path}`，不要机房/科技背景图（很违和）。
3. **联通线不主动文生图**：视觉靠图表 + 品牌红卡片 + 数据大字。**仅当用户明确要求配图/插画时**才文生图；需要真实图片时优先联网搜图并下载。
4. **品牌主框架不可改**：联通红 `C00000` + 亮红 `EE0000`、双 logo、微软雅黑、红色页眉规则线。风格词（科技风/婉约风…）**只**影响辅助色与留白，绝不改品牌身份。
5. **章节过渡页要么全有要么全无**：`章节数≥4 或 总页≥12` 才每章一张 `sectionSlide`，否则一张都不放。
6. **目录只放一级章节**，不要塞 1.1/1.2 子条目。

## 起手式（照抄）

```bash
cp <技能根目录>/<技能根>/scripts/pptkit.js ./pptkit.js
cp -r <技能根目录>/templates/unicom/assets ./assets        # ← logo，必做，否则 logo 空白
node <技能根目录>/<技能根>/scripts/theme_generator.js <技能根目录>/themes/unicom.json ./theme.js
```

```javascript
const pptxgen = require("pptxgenjs");
const THEME   = require("./theme.js");
const path    = require("path");
let pres = new pptxgen();
pres.defineLayout({ name: "UNICOM", width: 13.333, height: 7.5 });   // 联通画布，不是 LAYOUT_16x9
pres.layout = "UNICOM";
pres.author = "联通数据智能有限公司";

const K = require("./pptkit.js")(pres, THEME, {
  brand: "unicom",
  logos: { dual: path.join(__dirname, "assets/logo-cube-yuanjing.png") },   // 中国联通+联通元景 双 logo
});
const { coverSlide, tocSlide, sectionSlide, contentSlide, closingSlide,
        rowsOf, colsOf, featureRow, statRow, timelineRow, processRow,
        compareRow, barsBlock, chartBlock, bulletBlock, quoteBlock, charts } = K;

// === SLIDES START ===
// === SLIDES END ===

pres.writeFile({ fileName: "output.pptx" }).then(() => console.log("done"));
```

## 五种页型（与通用线同名同参，品牌样式自动套上）

```javascript
coverSlide({ title:"中国联通数智化转型 2026 年度总结", org:"联通数据智能有限公司", date:"2026 年 12 月" });

tocSlide({ chapters:["算力网络底座建设成果","元景大模型能力体系","行业数智化标杆案例","2027 年重点工作部署"] });

sectionSlide({ no:1, title:"算力网络底座建设成果", sub:"COMPUTING INFRASTRUCTURE" });

const { s, a } = contentSlide({ title:"算力网络投资突破 350 亿元，覆盖全国 300+ 城市", pageNo:4, note:"先讲底座投入。" });

closingSlide({ title:"谢谢观看", sub:"Thank You", org:"联通数据智能有限公司", date:"2026 年 12 月" });
```

内容区块（`featureRow` / `statRow` / `barsBlock` / `chartBlock` / `compareRow` / `processRow` / `timelineRow` /
`bulletBlock` / `quoteBlock`）用法与通用线完全一致，见 [components.md](components.md)。
**联通页不要用 kicker**（源模板页眉没有英文小字），只给 `title` + `pageNo`。

一页两块的标准写法：

```javascript
{
  const { s, a } = contentSlide({ title:"算力网络投资突破 350 亿元，覆盖全国 300+ 城市", pageNo:4 });
  const [top, bot] = rowsOf(a, [1, 1.7]);
  statRow(s, { a: top, items:[
    { value:"350亿", label:"年度算力投资总额" },
    { value:"300+",  label:"覆盖城市数量" },
    { value:"85%",   label:"算力平均利用率" },
  ]});
  const [l, r] = colsOf(bot, 2);
  barsBlock(s,  { a: l, title:"区域算力资源分布（EFLOPS）", items:[{name:"华东",v:120,label:"120"}, /* … */] });
  chartBlock(s, { a: r, title:"近三年算力规模增长", type: charts.BAR,
                  data:[{ name:"通用算力", labels:["2024","2025","2026"], values:[120,180,260] }],
                  opts:{ barDir:"col" } });
}
```

## 品牌规格（pptkit 已内建，此处仅备查）

| 项 | 值 |
| --- | --- |
| 画布 | **13.333 × 7.5**（必须 `defineLayout`） |
| 主红 / 亮红 / 灰 / 深灰 | `C00000` / `EE0000` / `808080` / `303030` |
| 字体 | Microsoft YaHei（目录英文可用 Impact） |
| 双 logo | `<技能根>/templates/unicom/assets/logo-cube-yuanjing.png`，比例 4.186:1；封面/结束页 `8.266,0.494,4.778,1.141`，内容页 `9.558,0.158,3.601,0.86` |
| 页眉 | 左红竖条 + 全宽红规则线（y=0.78, h=0.045）+ 右上双 logo |
| 源模板 pptx | `<技能根>/templates/unicom.pptx`（编辑流可复用） |

## 风格变体（只调氛围，不动品牌）

| 变体 | 做法 |
| --- | --- |
| 联通**科技风** | 内容页多用 `chartBlock` / `barsBlock` / `processRow`，卡片留白加大，KPI 大数字为主 |
| 联通**婉约风** | 多用 `bulletBlock` / `quoteBlock`，减少色块面积，行距与留白加大 |
| 联通**简约风** | 每页只放 1 个区块，文案压到预算下限 |
| 联通**商务风** | `statRow` + `compareRow` + `timelineRow` 组合，强调数据与对比 |

## 每页自检

`node slides.js` 必须打印 `[pptkit] ✅ 体检通过`；出现 `⚠` 按 [compact-reference.md](compact-reference.md) 的对照表改完再进下一页。
另外人工确认：①页序对（封面首、目录次、结束末）②每页都有双 logo 和红规则线 ③封面无背景图 ④目录无子条目。
