# 用户上传模板 · 复刻工作流 (Custom / Uploaded Template)

> **何时用**：用户上传了一个 `.pptx`（或 `.potx`）并说"照这个模板做 / 用我这个样式 / 套这个模板"。
> 目标：让产出的 PPT **长得就像用户给的模板**（配色、字体、logo、封面/目录/内容版式一致）。

本技能有一个脚本 `<技能根>/scripts/analyze_template.py`，会把上传的模板**自动拆解成可复刻的资料**——这正是人工复刻一套品牌模板要做的全部前置工作，一条命令搞定。

---

## 第一步：分析上传的模板（必做）

```bash
python <技能根>/scripts/analyze_template.py <用户上传的.pptx> --out template_analysis
```

它会在 `template_analysis/` 下产出：

| 产物 | 内容 |
| --- | --- |
| `theme.json` | 自动推断的品牌主题（主色/辅助色取自幻灯片实际用色直方图；字体取自 fontScheme；已保证 6 位 hex 合规）。可直接 `node <技能根>/scripts/theme_generator.js template_analysis/theme.json` 生成 theme.js |
| `ANALYSIS.md` | 完整报告：**画布尺寸 + 建议的 pptxgenjs layout**、主题色板、字体、**每一页逐个形状的坐标(英寸)/几何/填充/描边/文字(内容·字号·粗细·颜色·字体·对齐)** |
| `assets/` | 抽取出来的**所有 logo / 背景图**（image1.png…），复刻时直接引用 |

先 `cat template_analysis/ANALYSIS.md` 通读，心里就有了模板的"骨架"。

---

## 第二步：选一条复刻路径

### 路径 A —— 用 pptxgenjs 重画（**推荐，效果最好**）

适合绝大多数情况：产出干净、可控、可逐页微调，且能自由填充用户的新内容。

1. 读 `ANALYSIS.md`，确定：**画布 layout**（直接抄它给的 `pres.defineLayout(...)` 那行）、配色（用 `theme.json`）、字体、logo 摆位（`assets/` + 报告里的坐标）。
2. 归纳出 5 种页型的坐标：**封面 / 目录 / 章节过渡 / 内容页 / 结束页**（报告里每页的形状坐标就是现成的还原依据）。
3. 生成 theme.js：`node <技能根>/scripts/theme_generator.js template_analysis/theme.json`。
4. 把 `template_analysis/assets/` 里的 logo 拷到 slides.js 同级（如 `./assets/`）。
5. `cp <技能根>/scripts/pptkit.js ./pptkit.js`，按下面的「**画框 / 填瓤 分开写**」落地。
6. 逐页 `node slides.js` + PptxProgress。

---

#### ⚠️ 复刻路线最容易翻的车：**版式坍缩**

实测教训：模型一上来就写一个"整页函数"`content(no, title, colA, colB)`，然后调它 8 次填不同文字——
框复刻得再准，出来也是 8 页同构的稿子，比不复刻还难看。**框要一样，瓤必须每页不一样。**

正确写法是把两件事拆开，pptkit 给了专门的入口 **`K.setFrame(fn)`**：

```js
// ① 框：注册一次，画模板每页都有的"不变量"——侧栏 / 顶部色带 / 页眉页脚 / 编号 / logo。
//    坐标照抄 ANALYSIS.md。**必须 return 正文可用区** {x,y,w,h}，框自己不碰正文。
//    ⚠ 编号别搞两套：侧栏那个大数字是**所属章号**（和章节过渡页上的数字对得上），
//    页序号放页脚小字。实测出过"章节页写 01、翻过去内容页侧栏写 02"，读者直接懵。
K.setFrame(function (s, o) {
  s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 1.55, h: 7.5, fill: { color: C.primary } });
  s.addText(String(o.chapterNo || "").padStart(2, "0"), { x: 0, y: 0.6, w: 1.55, h: 1.0,
    align: "center", fontFace: F.title, fontSize: 34, color: C.accent, margin: 0 });
  if (o.kicker) s.addText(String(o.kicker).toUpperCase(), { x: 2.15, y: 0.62, w: 8, h: 0.34,
    fontFace: F.accent, fontSize: 11, bold: true, color: C.secondary, charSpacing: 3, margin: 0 });
  s.addText(o.title || "", { x: 2.15, y: 1.02, w: 10.1, h: 0.95, fontFace: F.title, fontSize: 30,
    color: C.text_on_light, margin: 0 });
  s.addShape(pres.shapes.RECTANGLE, { x: 2.15, y: 2.16, w: 10.1, h: 0.02, fill: { color: C.card_border } });
  s.addText("Meridian Partners", { x: 2.15, y: 6.92, w: 5, h: 0.3, fontFace: F.body, fontSize: 10,
    color: C.text_muted, margin: 0 });
  return { x: 2.15, y: 2.5, w: 10.1, h: 4.25 };            // ← 正文区，必须返回
});

// ② 瓤：照常用 page.free / contentSlide，每页换一种区块组合。
//    注册过 frame 之后，它们会自动用你的框 + 你返回的正文区，你什么都不用改。
page.free({ chapterNo: 1, kicker: "Business Lines", title: "三条业务线全线增长", blocks: [
  { statStrip: { items: [...] } },
  { row: [{ chart: { type: "bar", ... }, flex: 1.3 }, { bullets: { ... } }] },
]});
```

**为什么必须走 `setFrame` 而不是自己写整页**：实测里模型被叮嘱"自己画框"之后，
照旧调了 10 次 `contentSlide()`，结果模板最认脸的顶部色带整份丢失——颜色字体都对，
就是不像那个模板。注册进引擎才是可靠的：一次注册，全篇生效，而且正文继续享受
自动分高、防溢出、字号统一、排版体检。

正文区**不要手算坐标**，手算的那一刻就失去了体检保护。若某一页要在框外单独发挥
（整幅图页、大字页），直接 `pres.addSlide()` 自己画即可，`setFrame` 只作用于内置页型。

**页型配额（8–10 页的稿子请照此分布）**：

| 出现次数 | 内容 |
| --- | --- |
| ≤ 2 页 | 同一种正文结构（`statStrip` + 两块文字是最容易滥用的那个，最多用两次） |
| ≥ 2 页 | 带**图表**（`chart` / `bars`） |
| ≥ 1 页 | 带**真实图片**（模板 `assets/` 里抽出来的图、或联网搜到下载的图） |
| ≥ 2 页 | 从 `timeline / process / compare / matrix / layers / quote / table / numberList` 里各取不同的 |
| 1 页 | 章节过渡页（用模板的深色底色，只有大字，给全篇换口气） |

写完检查一遍：**有没有两页的区块组合是一样的？** 有就换掉其中一页。

> 内置「联通模板」就是这么诞生的——[unicom-template.md](unicom-template.md) 是照 `analyze_template.py` 的同类分析逐页复刻出来的，可当"标准答案范例"参考。

### 路径 B —— 就地编辑用户的 pptx（保留原母版/占位符时用）

当用户明确要"**在我这个文件里填内容、保留母版**"时，走 [editing.md](editing.md) 的解包→改 XML→打包流程，直接往用户上传的 pptx 里填。

**怎么选**：要新做一套内容、要美观可控 → **路径 A**；要严格沿用用户文件的母版与占位符 → 路径 B。

---

## 第三步（可选）：把它固化成一套可复用模板

如果用户希望以后都能用这套模板：

```bash
# 登记进**用户模板目录**（$PPTX_TEMPLATES_DIR → $HEXAGENT_DATA_DIR/ppt-templates → ./ppt-templates），
# 附上风格标签，template_manager 之后可 match。技能自带的内置模板只读，不会被写。
python <技能根>/scripts/template_manager.py add <用户.pptx> --name "客户品牌模板" --tags 客户 品牌 corporate
```

复刻好的 `theme.json` 和（可选的）`xxx-template.md` 逐页指南也放在**同一个用户模板目录**里，
和上面登记的 pptx 待在一起。之后 `template_manager.py list` 会把用户模板和内置模板一起列出来
（同名时用户的优先），效果和内置模板一样。

> **绝不要往 `<技能根>/templates/` 或 `<技能根>/themes/` 里写。** 那是只读的安装目录，
> 技能市场一更新就整个覆盖：存进去的模板会丢，或者被打进下一次分发包发给别的用户。

---

## 关键约束（复刻时务必守）

- **尺寸**：严格用 `ANALYSIS.md` 给的画布 layout（很多品牌模板是 13.333×7.5 宽屏，不是默认 10×5.625）。
- **配色/字体**：用 `theme.json`（`THEME.colors.*` / `THEME.fonts.*`），不要另起炉灶配色。
- **logo**：用 `assets/` 里抽出来的真实 logo，按报告坐标摆位，**保持宽高比**（别拉伸）。
- **图层顺序**：先背景/卡底，后内容（见 [components.md](components.md) 的 `K.card()`）。
- **页底色**：`theme.json` 的 `bg_light` 不是纯白时（米色纸、浅灰底这类很常见），每页都要
  `s.background = { color: C.bg_light }`，漏一页就露白，很扎眼。（pptkit 会在 writeFile 时兜底补上，但别指望它。）
- **版式别坍缩**：见上面的「页型配额」，同一种正文结构最多用两次。
- **每页跑 `node slides.js` 看 pptkit 体检**，`⚠` 必须改完再继续。
- 封面尊重原模板的封面风格（原模板是左侧栏压字就别改成满版大图）。配图优先用模板 `assets/` 里抽出来的真实素材，
  其次联网搜真图，**不要张口就生图**（规则见 skill.md 的「配图规则」）。
