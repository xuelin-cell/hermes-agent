---
name: data-insight-viz
description: "分析表格数据并生成图表、看板和数据洞察报告."
version: "2.0.0"
author: "UniWork"
license: MIT
platforms: [linux, macos, windows]
tags: [数据分析, 可视化, 图表]
metadata:
  version: "2.0.0"
  OpenAgent: "📈"
---

# 数据可视化分析

把表格数据变成**读起来像同一个系统**的图表和洞察报告。

这不是"随手挑个颜色画个图"，而是一套**可验证的方法**：图形不靠习惯选（数据的
职责决定形，有时正确答案根本不是图表），颜色不靠肉眼挑（每种颜色只干一件事，
一套调色板要过六项检查）。方法本身与绘图库无关；**ECharts 是默认落地路径**，
`references/echarts.md` 负责把设计决策翻译成配置字段。

> 成品（报告、HTML 图表、导出的 PNG）写入当前工作目录。中文场景下坐标轴/图例/
> 标题用中文，字体栈见 `references/palette.md` 的 CJK 一节。
> 与 `frontend-design`（前端界面）互补——那个技能里但凡要画图，都以本技能为准。

## 按需读参考文件

**在动手对应环节前读对应文件**，别一次全塞进上下文。

| 参考文件 | 什么时候读 |
|---|---|
| `references/data-analysis.md` | 装载/剖析/清洗数据、写 SQL 或 pandas、做统计分析时 |
| `references/choosing-a-form.md` | **定图形之前最先读**。判断"是不是该用图表"、按数据职责选类型、序列数阶梯 |
| `references/color-formula.md` | 配色前。四种颜色职责 + 六项检查 + 品牌色"贴合最近可行值" |
| `references/palette.md` | 要具体色值时。已验证的默认调色板，也是替换品牌色的模板 |
| `references/echarts.md` | 生成 ECharts 配置时。字段映射 + JSON 规则 + 安全模板 + 校验 |
| `references/marks-and-anatomy.md` | 画具体图元时。柱/线/点/面规格、标签规则、容器、纹理通道 |
| `references/interaction.md` | 加 tooltip、图例、筛选器、联动时（HTML 图表） |
| `references/report-template.md` | 写洞察计划和最终报告时 |
| `references/anti-patterns.md` | 交付前自检 |

## 核心方法

### 一、先选形

先问**"这是不是该用图表"**：单个当前值 → 数字卡；几个头条数字 → KPI 行；
单一比率对上限 → 仪表/进度条；超过 ~7 个有意义的类别 → 表格。

再按**读者要做什么**选形，而不是按数据长什么样。三条铁律：

1. **顺序色是安全默认** —— 单一色相、越深越大，最不容易误读。
2. **分类色只用于"序列本身就是主角"的时候**，代价是淹没那个真正重要的点。
3. **强调是最被低估的形** —— 一条序列上重点色、其余全灰。故事是"这一条涨了"
   的时候，答案是强调，不是分类。

**序列数阶梯**：1–3 直接标注即可 · **4 = 色盲下限，直接标签变成必需** ·
5–6 软上限，用图例或小多图 · 7–8 是槽位天花板 · 再多就折叠成"其他"或拆小多图。
**永远不要靠"再生成一个颜色"来解决序列太多**——第 9 个色相在色盲下和已有色几乎不可分。

### 二、每种颜色只干一件事

| 职责 | 编码什么 | 结构 |
|---|---|---|
| 分类 categorical | 身份（哪个序列） | 8 个固定色相、固定顺序、顺次分配、不循环 |
| 有序 ordinal | 在序列中的位置（漏斗阶段、档位） | 单一色相、亮度单调 |
| 顺序 sequential | 量级（多少） | 单一色相、由浅到深 |
| 发散 diverging | 极性（基线哪一侧） | 两色相 + 中性灰中点、两臂等步 |
| 状态 status | 状态（好→危急） | 固定小量表、含义保留、**永远配图标+文字** |

**分类还是有序？** 打乱顺序会改变含义（漏斗阶段、S/M/L、年龄段）就是有序，用单色
ramp；不会（产品名、地区、团队）就是分类。**绝不按数值给名义类别的柱子上色**——
柱长已经说了这件事。

### 三、配色不靠眼睛，靠脚本

任何分类调色板都要过六项检查（固定色相锚点、亮度带、色度下限、CVD 分离度、
对背景对比、只用已记录色值）。**每个模式各跑一次：**

```bash
node scripts/validate_palette.js "<8色逗号分隔>" --mode light
node scripts/validate_palette.js "<深色版8色>" --mode dark --surface "#1a1a19"
```
无 node 时用 `python scripts/validate_palette.py`，参数完全一致。
散点/气泡/地图/小多图加 `--pairs all`；有序 ramp 加 `--ordinal`。
退出码 0 = 无硬失败（WARN 仍需二级编码：直接标签/纹理/表格视图）；1 = 有 FAIL。

换品牌色时不要凭感觉改——按 `color-formula.md` 的"贴合最近可行值"逐槽位取档、
跑校验、微调亮度保色相，直到最差相邻对过线。

## 工作流：表格数据 → 洞察报告

### Phase 1 装载与剖析
读 `references/data-analysis.md`。`analyze.py --action inspect` 看结构 →
`--action summary` 出统计摘要 → 按剖析结果清洗，并记录每一步（报告的"方法论"要写）。

### Phase 2 洞察计划（先写计划，不要画图）
统计分析（描述性统计、趋势、相关、分群）→ 规划 **4–7 张图**，写成
`references/report-template.md` 的计划表。每行先填"读者要做什么"，再倒推图形和
颜色职责。**质量优先于数量**：每张图必须直接回答用户的问题，不要为了探索而画。

### Phase 3 逐张生成（一次只做一张）

**必须一张一张来，不要一次性生成所有图表。**

```
图 1 → 生成 → 校验 → 修复 → 确认 ┐
图 2 → 生成 → 校验 → 修复 → 确认 ├─ 全部通过后才进入 Phase 4
图 N → ...                      ┘
```

每张图写入 `output_fs/charts/chart_NN.md`（模板见 `report-template.md`），然后：

```bash
python scripts/validate_echarts.py output_fs/charts/chart_01.md
```
有 ERROR 就地修完再继续，不要攒到最后。常见错误速查见 `references/echarts.md`。

⚠️ **校验器不检查颜色。** 分类色数组对不对、深色底有没有换数组、4+ 序列有没有开
直接标签——这几条只能靠 `echarts.md` 的模板自带和交付前自检兜住。

### Phase 4 合并成报告

写入 `output_fs/data_insight_report.md`，结构见 `references/report-template.md`。

**唯一的硬规则：每张图必须完整内联。** 用 Read 工具读取每个 `chart_NN.md` 的
完整内容，把 ` ```echarts ` 配置和洞察文字直接嵌进最终报告，逐图核对没有遗漏。

禁止：文件路径引用（`详见 chart_01.md`）、链接（`[查看图表](...)`）、
占位符（`（图表已生成在…）`）、省略某张图的洞察段落。这些在最终产物里都是空的。

## 交付前自检

- [ ] 图形选对了——先问过"这是不是该用图表"
- [ ] 每种颜色职责明确；分类色跑过校验脚本，明暗两版都跑
- [ ] 每个配置都有 `color` 字段，取自 `palette.md`，且与明暗模式匹配
- [ ] 4+ 序列开了直接标签（`label.show`）或纹理等二级编码
- [ ] 状态色都配了图标+文字，没和分类色混用
- [ ] 每张图跑过 `validate_echarts.py` 且退出码 0
- [ ] 报告里每张图都是完整内联的 echarts 块，没有路径引用或占位符
- [ ] 中文字体正常显示；对照 `anti-patterns.md` 排雷
