# 通用主模板：一套骨架 × 17 套主题

> 页型和区块的**用法**全部在 [components.md](components.md)。本文只讲**一份 deck 该怎么排**：片单、节奏、主题选型。
> 换主题 = 换 `theme.js`，同一份 slides.js 在 17 套主题下都协调。
> 联通品牌精确复刻走 [unicom-template.md](unicom-template.md)；客户上传的 pptx 走 [custom-template.md](custom-template.md)。

## 1. 选主题

```bash
node <技能根>/scripts/theme_generator.js <技能根>/themes/<主题>.json ./theme.js
```

| 场景 | 主题 |
| --- | --- |
| 高管汇报 / 年度总结 / 财报 | `midnight-executive` · `finance-gold` |
| 科技 / AI / 数字化转型 | `tech-innovation` · `charcoal-minimal` |
| 咨询 / 战略 / 行业研究 | `ocean-gradient` · `teal-trust` |
| 营销 / 发布会 / 路演 | `coral-energy` · `cherry-bold` |
| 医疗 / 教育 / 公共服务 | `medical-clean` · `education-warm` |
| 环保 / 生活方式 / 餐饮文旅 | `forest-moss` · `sage-calm` · `sunset-warm` · `berry-cream` |
| 国风 / 年会 / 文化 | `chinese-ink` · `chinese-festive` |
| 中国联通相关 | **走 [unicom-template.md](unicom-template.md)**（优先级最高） |

不确定就用 `midnight-executive` 或 `charcoal-minimal`。

## 2. 标准片单蓝图（直接照抄节奏）

**8–10 页（汇报 / 简报）**
1 封面 → 2 目录 → 3 现状总览（`statRow` + `chartBlock`）→ 4 核心能力（`featureRow`）→ 5 数据洞察（`barsBlock` 或 `chartBlock`）→ 6 路径 / 流程（`processRow`）→ 7 对比 / 成效（`compareRow`）→ 8 结论金句（`quoteBlock`）→ 9 结束页

**12–15 页（方案 / 年度总结）**
封面 → 目录 → **章节页 1** → 2–3 张内容 → **章节页 2** → 2–3 张内容 → **章节页 3** → 2–3 张内容 → 结论 → 结束页

**18–20 页（深度报告）**
在 12–15 页基础上每章多 1–2 张内容页，并在每章末加一张 `statRow` 小结页。

> 🔴 **章节过渡页要么全有要么全无**：`章节数≥4 或 总页数≥12` 时，每个一级章节前放一张 `sectionSlide`，否则一张都不放。**严禁只给部分章节放**（那是最典型的 AI 味）。
>
> **和用户指定页数冲突时的决策顺序**（很常见：用户要 10 页，内容自然分 4 章，加过渡页就变 14 页）：
> ① **用户指定的页数优先**（这是硬约束）→ ② 把章节压到 3 章以内，走"不放过渡页"分支 →
> ③ 实在压不动，就在页数内**减少内容页**给过渡页腾位置。**绝不允许**"只给部分章节放过渡页"或悄悄超页。
> 🔴 **页序固定**：封面第 1 → 目录第 2 → 中间内容 → **结束页永远最后一张**。`addSlide` 顺序就是最终页序。

## 3. 节奏与轮换铁律（防"页页长一样"）

**相邻两张内容页不得使用同一种版式。** 一份 10 页的 deck，内容页里应该出现：

| 类型 | 至少几张 | 用什么 |
| --- | --- | --- |
| 高密度页（2–3 个块） | **≥3 张** | `page.free`：`statStrip` + `row[chart/bars + bullets]` + `callout` |
| 图示型页 | **≥1 张** | `page.layers`（分层架构）/ `page.matrix`（2×2 象限） |
| 结构性页（打破节奏） | **≥1 张** | `page.statement`（整幅色块大字）/ `page.bigNumber`（半页大数字）/ `page.panel`（左侧面板） |
| 表格页 | 有数据就上 | `page.free` 里放 `table` |

推荐的主区块轮换序：
```
statStrip+chart → cards → table+numbers → layers/matrix → compare → statement/bigNumber → bars+bullets
```

> 判断"是不是像小学生 PPT"的最快办法：把 10 张缩略图并排看。
> **如果每一张的骨架都是"标题 + 三个并排的白卡"，那就是。** 商用稿的 10 页里应该有 5–6 种不同骨架。

## 4. 每页必做三件事

1. `contentSlide({ kicker, title, pageNo, note })` —— `title` 写**观点句**（结论 + 数字），`note` 写 1–2 句讲稿（客户拿到即可上台照读）。
2. 用 `rowsOf` / `colsOf` 切区域，往里放 1–2 个区块。**不要手写坐标。**
3. `node slides.js` 看体检输出：`✅` 才进下一页，`⚠` 先修。

## 5. 中文字体兜底

Linux 沙箱若无微软雅黑（渲染出方块），把 `theme.js` 里 `fonts.title/body` 改成 `"Noto Sans CJK SC"` 或 `"WenQuanYi Micro Hei"` 后重跑。
