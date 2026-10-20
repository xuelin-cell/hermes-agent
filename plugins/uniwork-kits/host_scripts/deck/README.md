# uniwork-deck 版式库

宿主自带的 PPT 版式库：选一套风格，每页调用一个版式函数填内容。坐标、字号（按字数自动缩放）、图片比例、页码都由库算好，不要再自己写版式函数。只依赖 pptxgenjs。

## 用法

```js
// build.js
const PptxGenJS = require('pptxgenjs')
const { createDeck } = require('<版式库绝对路径>/uniwork-deck.js')
const deck = createDeck(PptxGenJS, { theme: 'navy-teal', title: 'PPT 标题' })   // title 会印在正文页页脚
require('./slides_1.js')(deck)
require('./slides_2.js')(deck)
deck.save('C:/绝对路径/输出.pptx').then(f => console.log('saved', f))
```

```js
// slides_1.js：每个分页文件导出一个函数，按顺序调用版式函数
module.exports = function (deck) {
  deck.cover({ title: '……', subtitle: '……', kicker: '2026 年度汇报', meta: '部门 · 日期', image: 'C:/…/cover.png', source: 'UniAI 生成' })
  deck.agenda({ items: [{ head: '现状', text: '一句话' }, '转型路径', '下一步'] })
}
```

## 风格（theme）

| 名称 | 风格 | 适合 |
|---|---|---|
| navy-teal | 深海蓝·青 | 默认；商务汇报、科技、咨询 |
| ink-gold | 墨黑·金 | 高端发布、金融、品牌、年会 |
| china-red | 中国红 | 党建、政务、传统文化、节庆 |
| forest-green | 森林绿 | 环保、农业、医疗健康、ESG |
| ocean-light | 浅海蓝 | 通用正式汇报、政企方案 |
| graphite-orange | 石墨·橙 | 工业制造、工程、运营复盘 |
| tech-purple | 科技紫 | AI、互联网、产品发布 |
| warm-sand | 暖沙 | 文旅、餐饮、人文、生活方式 |
| minimal-mono | 极简黑白 | 学术、设计、极简风 |
| sky-education | 教育天蓝 | 教学课件、培训、儿童 |

按主题和听众选一套，整份 PPT 只用这一套。`deck.theme` 里是这套的颜色（dark、light、card、primary、accent、accent2、text、muted、line、onDark、onDarkMuted、accentOnDark），自定义页里用它们取色。

## 版式函数

要点（points、items）每项可以是字符串，也可以是 `{ head, text }`。title、kicker（小标签）、lead（标题下的一句导语）、notes（演讲备注）在各正文版式里都可选。

| 函数 | 内容参数 | 用途 |
|---|---|---|
| `cover` | title, subtitle, kicker, meta, image?, source? | 封面（深色） |
| `agenda` | items（2～8） | 目录 |
| `section` | no（如 '01'）, title, subtitle, image?, source? | 章节页（深色） |
| `bullets` | points（1～8）, image?, source? | 要点；有图时左文右图 |
| `cards` | cards（2～6，`{ head, text, badge? }`） | 并列卡片，自动排一行或两行 |
| `stats` | stats（2～4，`{ value, label, note }`）, points?（1～4） | 大数字指标 |
| `chart` | type（bar / line / pie / doughnut）, categories, series（`[{ name, values }]`）, note?, points?（1～5） | 图表，values 必须是数字 |
| `table` | header（2～8 列）, rows（1～12 行，二维字符串数组）, note? | 表格 |
| `timeline` | steps（2～6，`{ time, head, text }`） | 时间线 |
| `process` | steps（2～6，`{ head, text }`） | 流程步骤 |
| `compare` | columns（2～4，`{ head, points: [...] }`） | 多栏对比 |
| `matrix` | quadrants（正好 4 个，左上、右上、左下、右下）, xLabel, yLabel | 四象限 |
| `imageText` | image, source, points（1～5） | 左大图、右要点 |
| `quote` | text, author | 金句、引言 |
| `closing` | title（默认「谢谢」）, subtitle, points?（1～4） | 结尾（深色） |
| `custom` | (opts, draw) | 以上都不合适时的自定义页 |

自定义页：`deck.custom({ title, kicker, lead }, ({ slide, area, theme, text, picture, rect, circle }) => { … })`。抬头已画好，只在 `area`（正文区，英寸坐标 `{ x, y, w, h }`）里画。`text(文字, 框, { maxPt, minPt, bold, color, align })` 自动定字号；`picture(路径, 框, { source })` 按原比例放图；`rect(框, 颜色, { round, line })`、`circle(框, 颜色, { ring })` 画色块。

## 规矩

- 一页一个版式函数。参数传错（数组项数不对、该填文字的地方传了对象、图表数值不是数字）会直接报错，按报错改参数，不要绕开。
- 图片用绝对路径。库会按原比例放进相框，不拉伸、不裁切；生成图右下角的水印会完整保留。图片来源写在 `source`。
- 页码、页脚由 `save()` 统一加在左下角，不要自己加。
- 文字按框自动缩放字号，但字数太多也只会缩到下限：每条要点控制在 40 字以内，每页要点不超过 6 条。
- 页面是 13.333×7.5 英寸（LAYOUT_WIDE）。
