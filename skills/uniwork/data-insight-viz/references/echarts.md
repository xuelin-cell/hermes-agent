# ECharts 落地层

设计决策（选什么形、每种颜色干什么）在 `choosing-a-form.md` / `color-formula.md`，
色值的唯一定义在 `palette.md`。**本文件只做一件事：把那些决策翻译成 ECharts 字段。**
色值不在此重新定义，只标注从 `palette.md` 的哪一节取——避免再造一份会腐化的副本。

---

## 一、颜色职责 → ECharts 字段

| 职责 | ECharts 落点 | 取值来源 |
|---|---|---|
| 分类 categorical | 根级 `color: []` | palette.md § Categorical，按槽位顺序，**不循环** |
| 顺序 sequential | `visualMap.inRange.color` | palette.md § Sequential hue，100→700 |
| 有序 ordinal | 同上，但收窄区间 | 浅色起点不浅于 step 250 `#86b6ef`；深色不深于 step 600 `#184f95` |
| 发散 diverging | `visualMap` 三段停靠点 | 蓝臂 + 中性灰 + 红臂，见下 |
| 状态 status | `itemStyle.color` 逐项指定 | palette.md § Status，**必须同时给图标或文字** |
| 强调 emphasis | 重点序列 `#2a78d6`，其余 `itemStyle.color: "#c3c2b7"` | 去强调灰 = chrome 表的 secondary ink (dark) |

### 分类色数组（直接粘）

浅色底：
```json
"color": ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"]
```
深色底：
```json
"color": ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767", "#d55181", "#d95926"]
```
只用前 N 个槽，N = 序列数。**第 9 个序列不存在**——折叠进"其他"或拆小多图
（`choosing-a-form.md` 的序列数阶梯）。

浅色底最差相邻 CVD ΔE = 24.2，安全；**深色底 = 10.3，落在 8–12 的 WARN 带**，
所以深色场景下 4+ 序列必须开直接标签（下面的 `label.show`），不能只靠颜色。

### 顺序色（热力图 / 连续量级）

```json
"visualMap": {
  "min": 0, "max": 100, "calculable": true,
  "inRange": { "color": ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"] }
}
```

### 有序色（漏斗阶段 / 档位 —— 离散且有先后）

和顺序色同一条 ramp，但**必须隔档取值**：相邻档位（如 450 与 500）亮度差只有
0.048，达不到 0.06 的下限，会被判 FAIL。已验证可用的 5 档（250/350/450/550/650）：

```json
"color": ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281"]
```
浅色底起点不浅于 step 250，深色底不深于 step 600。自己取档就跑
`python scripts/validate_palette.py "<色值>" --mode light --ordinal` 确认。

（把完整的 100→700 顺序 ramp 拿去跑 `--ordinal` 会在浅端对比度上失败——那是设计
如此，顺序编码的最浅档就该退到接近背景，别去"修"它。）

### 发散色（正负 / 对目标的差）

蓝 ↔ 红，中点为中性灰。三个停靠点即可，ECharts 在其间线性插值，两臂天然等步：

```json
"visualMap": {
  "min": -100, "max": 100, "calculable": true,
  "inRange": { "color": ["#184f95", "#f0efec", "#e34948"] }
}
```
深色底把中点换成 `#383835`。

要更细的分段，两臂各自从对应色相的 ramp 取等数量的档位，然后把每条臂当成 ordinal
ramp 单独跑一遍 `python scripts/validate_palette.py "<单臂色值>" --ordinal`。
`palette.md` 定义了发散对与中点，但没有列红臂的分档——自己取档就必须过校验，
不要凭眼睛调。

### 图表框架（背景 / 网格 / 坐标轴 / 文字）

取 `palette.md` § Chart chrome & ink。浅色底：

```json
"backgroundColor": "#fcfcfb",
"textStyle": { "color": "#52514e", "fontFamily": "system-ui, \"PingFang SC\", \"Microsoft YaHei\", \"Noto Sans SC\", sans-serif" },
"xAxis": { "axisLine": { "lineStyle": { "color": "#c3c2b7" } }, "axisLabel": { "color": "#898781" } },
"yAxis": { "splitLine": { "lineStyle": { "color": "#e1e0d9", "type": "solid" } } }
```
深色底换成 `#1a1a19` / `#c3c2b7` / `#383835` / `#898781` / `#2c2c2a`。
**网格线永远 `"type": "solid"`**，不要虚线（`anti-patterns.md`）。

---

## 二、JSON 硬规则

配置必须是**合法 JSON**，不是 JS 字面量。

| 规则 | ❌ | ✅ |
|---|---|---|
| 不能有函数 | `"formatter": function(p) {...}` | `"formatter": "{b}: {c}"` |
| 只能双引号 | `{'name': 'Sales'}` | `{"name": "Sales"}` |
| 不能有尾逗号 | `"data": [1, 2, 3,]` | `"data": [1, 2, 3]` |
| 数字不能是字符串 | `"data": ["100", "200"]` | `"data": [100, 200]` |
| 不能出现 undefined | `"value": undefined` | 省略该字段，或 `null` |
| xAxis 与 series 长度必须一致 | 3 个类别配 4 个数据点 | 两边对齐 |

⚠️ **引号检查是朴素的字符包含判断**：配置里出现**任何一个** `'`（哪怕在字符串值
内部、哪怕是中文标题里的英文撇号）都会被判 ERROR。字体名一律用 `\"` 转义，
标题避免撇号。

---

## 三、布局：不确定就不配

ECharts 默认布局在绝大多数情况下是对的。**只加你完全理解的属性。**

- 唯一常用的安全配置：`"grid": { "containLabel": true }`
- **不要**手写 `left / right / top / bottom` 去救被裁切的标签——猜出来的边距换一批
  数据就崩。先用 `containLabel`。
- title < 30 字符，legend < 10 项（超过就是选错了形）。
- 单序列**不要 legend**——标题已经说明了它是什么（`marks-and-anatomy.md`）。
- 容器固定高度必须包含 x 轴带，否则卡片内出现嵌套滚动。

---

## 四、安全模板

五个模板都已带正确的 `color`，直接改数据即可。**照抄时不要删 `color` 字段**——
`validate_echarts.py` 不检查颜色，删了不会报错，但图会掉回 ECharts 默认色板。

### 模板 1：柱状图（单序列，名义类别）

单序列用槽位 1，无 legend。**绝不按数值给名义类别的柱子上色**——柱长已经表达了数值。

```json
{
  "title": { "text": "各区域销售额" },
  "color": ["#2a78d6"],
  "tooltip": { "trigger": "axis" },
  "grid": { "containLabel": true },
  "xAxis": { "type": "category", "data": ["华东", "华北", "华南"] },
  "yAxis": { "type": "value" },
  "series": [{ "name": "销售额", "type": "bar", "barMaxWidth": 24, "data": [100, 200, 300] }]
}
```

### 模板 2：折线图（单序列时间趋势）

```json
{
  "title": { "text": "月度销售趋势" },
  "color": ["#2a78d6"],
  "tooltip": { "trigger": "axis" },
  "grid": { "containLabel": true },
  "xAxis": { "type": "category", "data": ["一月", "二月", "三月"] },
  "yAxis": { "type": "value" },
  "series": [{ "name": "销售额", "type": "line", "lineStyle": { "width": 2 }, "symbolSize": 8, "data": [100, 200, 300] }]
}
```

### 模板 3：饼图 / 环形图（部分对整体，一眼看比例）

**≤5 片**，且只用于"一眼看个大概"。要精确比大小就别用饼图，用模板 4。
环形图只是把 `radius` 换成 `["40%", "70%"]`，其余相同。

```json
{
  "title": { "text": "产品线占比" },
  "color": ["#2a78d6", "#1baf7a", "#eda100"],
  "tooltip": { "trigger": "item", "formatter": "{b}: {c} ({d}%)" },
  "legend": { "data": ["产品A", "产品B", "产品C"] },
  "series": [{
    "name": "占比",
    "type": "pie",
    "radius": "50%",
    "data": [
      { "name": "产品A", "value": 100 },
      { "name": "产品B", "value": 200 },
      { "name": "产品C", "value": 300 }
    ]
  }]
}
```

### 模板 4：横向堆叠柱（部分对整体，类别多或名称长）

设计系统里 part-to-whole 的**首选形**。类别名长、条目多时比饼图强得多。

```json
{
  "title": { "text": "各区域产品线构成" },
  "color": ["#2a78d6", "#1baf7a", "#eda100"],
  "tooltip": { "trigger": "axis" },
  "legend": { "data": ["产品A", "产品B", "产品C"] },
  "grid": { "containLabel": true },
  "xAxis": { "type": "value" },
  "yAxis": { "type": "category", "data": ["华东", "华北", "华南"] },
  "series": [
    { "name": "产品A", "type": "bar", "stack": "total", "barMaxWidth": 24, "data": [100, 120, 90] },
    { "name": "产品B", "type": "bar", "stack": "total", "barMaxWidth": 24, "data": [200, 150, 180] },
    { "name": "产品C", "type": "bar", "stack": "total", "barMaxWidth": 24, "data": [150, 170, 130] }
  ]
}
```

### 模板 5：分组柱（多序列对比，≥4 序列必须开标签）

**4 个序列是色盲下限**——到这里 `label.show` 不是锦上添花，是必需项。

```json
{
  "title": { "text": "季度业绩对比" },
  "color": ["#2a78d6", "#1baf7a", "#eda100", "#008300"],
  "tooltip": { "trigger": "axis" },
  "legend": { "data": ["Q1", "Q2", "Q3", "Q4"] },
  "grid": { "containLabel": true },
  "xAxis": { "type": "category", "data": ["华东", "华北", "华南"] },
  "yAxis": { "type": "value" },
  "series": [
    { "name": "Q1", "type": "bar", "barMaxWidth": 24, "label": { "show": true, "position": "top" }, "data": [100, 120, 90] },
    { "name": "Q2", "type": "bar", "barMaxWidth": 24, "label": { "show": true, "position": "top" }, "data": [200, 150, 180] },
    { "name": "Q3", "type": "bar", "barMaxWidth": 24, "label": { "show": true, "position": "top" }, "data": [150, 170, 130] },
    { "name": "Q4", "type": "bar", "barMaxWidth": 24, "label": { "show": true, "position": "top" }, "data": [180, 160, 210] }
  ]
}
```

序列数只有 1–3 时删掉 `label.show`，标签太密反而糟——见 `marks-and-anatomy.md`
的"选择性标注"。

---

## 五、校验（每张图必跑）

```bash
python scripts/validate_echarts.py output_fs/charts/chart_01.md
```
接受含 ` ```echarts ` 代码块的 Markdown、纯 JSON 文件，或 `-` 读标准输入。
退出码：**0** 通过 · **1** 有 ERROR · **2** 仅有 WARNING 且加了 `--strict`。
`--format json` 输出机器可读结果。

有 ERROR 就地修完再继续，不要攒到最后。

| 类别 | 检查项 | 级别 |
|---|---|---|
| JSON 语法 | JSON 解析 / 引号 / 尾逗号 / 函数 / undefined | ERROR |
| ECharts 结构 | `series` 非空数组 · `series[].type` 合法 · `series[].data` 是数组 | ERROR |
| ECharts 结构 | `title` / `tooltip` 存在 · 笛卡尔类型有 xAxis/yAxis · pie 的 name/value 结构 | ERROR |
| 数据完整性 | xAxis 与 series 长度匹配 · 无 NaN · 无 Infinity | ERROR |
| 数据完整性 | 数值不是字符串 | WARNING |
| 布局 | 手工 grid 定位 · title >30 字 · legend >10 项 · series >1000 点 | WARNING |

**校验器不检查颜色。** 分类色数组对不对、深色底有没有换数组、4+ 序列有没有开
标签——这几条只能靠模板自带和交付前自检兜住。调色板本身的正确性用另一个脚本：

```bash
node scripts/validate_palette.js "<8色逗号分隔>" --mode light
node scripts/validate_palette.js "<深色版8色>" --mode dark --surface "#1a1a19"
```
无 node 时 `python scripts/validate_palette.py`，参数完全一致。
散点/气泡/地图/小多图加 `--pairs all`（任意两个 mark 都可能相邻）。
