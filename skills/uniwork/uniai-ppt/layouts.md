# Slide Layout Cookbook (幻灯片版式手册)

> ⚠️ **本文只当"版式灵感库"看，不要照抄里面的硬编码坐标。**
> 落地实现一律用 [components.md](components.md) 的出稿套件（`contentSlide` + `rowsOf/colsOf` + 区块）——
> 它自带防溢出、字号统一、图层顺序和排版体检。手抄本文的 x/y 数字会直接把"文字溢出 / 元素重叠"带回来。
> 对照表：双栏→`colsOf`；卡片网格→`featureRow`；大数字→`statRow`；时间线→`timelineRow`；
> 流程→`processRow`；对比→`compareRow`；排行→`barsBlock`；图文→`imageBlock`；引言→`quoteBlock`。

> 12+ ready-to-use PptxGenJS layout patterns.
> All code uses `THEME` variables from `theme.js` -- never hardcode colors/fonts.
> Each style factory (`THEME.titleStyle()`, `THEME.bodyStyle()`, etc.) returns a
> **new** object every call, safe for PptxGenJS which mutates options in-place.

## Rules (re-read before every slide)

- **Canvas**: LAYOUT_16x9 = 10" x 5.625"
- **Margins**: min 0.5" all sides
- **Spacing**: 0.3-0.5" between content blocks
- **Colors**: 6-char hex, NO `#` prefix
- **Bullets**: `bullet: true`, NEVER unicode `"•"`
- **Line breaks**: `breakLine: true` between text array items
- **NO accent lines** under titles (AI hallmark)
- **Body text**: left-align; only titles may center

---

## Layout 1: cover-fullbleed (封面 - 全屏背景图)

Full-bleed background image with dark overlay.
Large centered title in white, subtitle below.

**Use when**: opening slide, section divider with hero image.

```
+------------------------------------------+
|  (background image covers full slide)    |
|  +--------------------------------------+|
|  |  dark overlay (50% transparent)      ||
|  |                                      ||
|  |       PRESENTATION TITLE             ||
|  |       subtitle text here             ||
|  |                                      ||
|  +--------------------------------------+|
+------------------------------------------+
```

```javascript
// --- Layout 1: cover-fullbleed ---
const slide = pres.addSlide();

// Full-bleed background image
slide.background = { path: imagePath };

// Dark overlay rectangle (50% transparent)
slide.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 0, w: 10, h: 5.625,
  fill: { color: THEME.colors.bg_dark, transparency: 50 },
});

// Title -- large, centered, white
slide.addText(titleText, {
  x: 1, y: 1.6, w: 8, h: 1.2,
  ...THEME.titleStyle({
    fontSize: 44,
    color: THEME.colors.text_on_dark,
    align: "center",
    valign: "middle",
  }),
});

// Subtitle
slide.addText(subtitleText, {
  x: 1.5, y: 3.0, w: 7, h: 0.8,
  ...THEME.subtitleStyle({
    fontSize: 20,
    color: THEME.colors.text_on_dark,
    align: "center",
    valign: "top",
    bold: false,
  }),
});
```

---

## Layout 2: toc-numbered (目录页)

Numbered section list with accent bar decoration.
Section numbers in large accent color, titles next to numbers.

**Use when**: table of contents, agenda slide, section overview.

```
+------------------------------------------+
| |  01  Section Title One                 |
| |  02  Section Title Two                 |
| |  03  Section Title Three               |
| |  04  Section Title Four                |
| |  05  Section Title Five                |
+------------------------------------------+
  ^accent bar
```

```javascript
// --- Layout 2: toc-numbered ---
const slide = pres.addSlide();
slide.background = { color: THEME.colors.bg_dark };

// Left accent bar
slide.addShape(pres.shapes.RECTANGLE, {
  ...THEME.accentBar({ x: 0.4, y: 0.5, w: 0.06, h: 4.625 }),
});

// Page title
slide.addText("CONTENTS", {
  x: 0.7, y: 0.3, w: 3, h: 0.5,
  ...THEME.captionStyle({
    fontSize: 14,
    color: THEME.colors.accent,
    bold: true,
    charSpacing: 4,
  }),
});

// Section entries
const sections = [
  { num: "01", title: "Section Title One" },
  { num: "02", title: "Section Title Two" },
  { num: "03", title: "Section Title Three" },
  { num: "04", title: "Section Title Four" },
  { num: "05", title: "Section Title Five" },
];

sections.forEach((sec, i) => {
  const yPos = 1.1 + i * 0.75;

  // Large number in accent color
  slide.addText(sec.num, {
    x: 0.7, y: yPos, w: 1.0, h: 0.6,
    ...THEME.titleStyle({
      fontSize: 36,
      color: THEME.colors.accent,
      align: "left",
      valign: "middle",
    }),
  });

  // Section title
  slide.addText(sec.title, {
    x: 1.8, y: yPos, w: 7, h: 0.6,
    ...THEME.subtitleStyle({
      fontSize: 22,
      color: THEME.colors.text_on_dark,
      align: "left",
      valign: "middle",
      bold: false,
    }),
  });
});
```

---

## Layout 3: content-split (内容双栏 - 左文右图)

Left half has title, body text, and bullet points.
Right half has a full-height image.

**Use when**: main content slides, feature explanations with supporting visual.

```
+--------------------+---------------------+
|                    |                     |
|  SLIDE TITLE       |                     |
|                    |   (image fills      |
|  Body text here    |    right half)      |
|  - Bullet point 1  |                     |
|  - Bullet point 2  |                     |
|  - Bullet point 3  |                     |
+--------------------+---------------------+
```

```javascript
// --- Layout 3: content-split ---
const slide = pres.addSlide();
slide.background = { color: THEME.colors.bg_light };

// Left column: title
slide.addText(titleText, {
  x: 0.5, y: 0.5, w: 4.2, h: 0.8,
  ...THEME.titleStyle({
    fontSize: 32,
    color: THEME.colors.text_on_light,
    align: "left",
    valign: "bottom",
  }),
});

// Left column: body text with bullets
const bulletItems = [
  { text: "First key point explained clearly", options: { bullet: true, breakLine: true } },
  { text: "Second insight with supporting detail", options: { bullet: true, breakLine: true } },
  { text: "Third takeaway for the audience", options: { bullet: true } },
];
slide.addText(bulletItems, {
  x: 0.5, y: 1.6, w: 4.2, h: 3.2,
  ...THEME.bodyStyle({
    fontSize: 16,
    color: THEME.colors.text_on_light,
    align: "left",
    valign: "top",
    lineSpacingMultiple: 1.4,
  }),
});

// Right column: image (full height)
slide.addImage({
  path: imagePath,
  x: 5.0, y: 0, w: 5.0, h: 5.625,
  sizing: { type: "cover", w: 5.0, h: 5.625 },
});
```

---

## Layout 4: data-highlight (数据突出)

One HUGE number in accent color on the left side.
Label below the number, supporting content on the right.

**Use when**: highlighting a key metric, revenue figure, growth rate, or KPI.

```
+------------------------------------------+
|                                          |
|   87%          Supporting description    |
|   Conversion   text or chart image       |
|   Rate         goes on the right side    |
|                of the slide.             |
|                                          |
+------------------------------------------+
```

```javascript
// --- Layout 4: data-highlight ---
const slide = pres.addSlide();
slide.background = { color: THEME.colors.bg_dark };

// Huge number -- left side
slide.addText(bigNumber, {
  x: 0.5, y: 1.0, w: 4.0, h: 2.0,
  ...THEME.titleStyle({
    fontSize: 72,
    color: THEME.colors.accent,
    align: "left",
    valign: "bottom",
    bold: true,
  }),
});

// Label below the number
slide.addText(metricLabel, {
  x: 0.5, y: 3.0, w: 4.0, h: 0.8,
  ...THEME.bodyStyle({
    fontSize: 20,
    color: THEME.colors.text_muted,
    align: "left",
    valign: "top",
  }),
});

// Optional trend indicator (small text)
slide.addText(trendText, {
  x: 0.5, y: 3.8, w: 4.0, h: 0.5,
  ...THEME.captionStyle({
    fontSize: 14,
    color: THEME.colors.accent,
    align: "left",
  }),
});

// Right side: supporting description or chart image
slide.addText([
  { text: descriptionTitle, options: { bold: true, breakLine: true } },
  { text: descriptionBody },
], {
  x: 5.0, y: 1.2, w: 4.5, h: 3.2,
  ...THEME.bodyStyle({
    fontSize: 16,
    color: THEME.colors.text_on_dark,
    align: "left",
    valign: "middle",
    lineSpacingMultiple: 1.5,
  }),
});

// OR: replace text with a chart image on the right
// slide.addImage({
//   path: chartImagePath,
//   x: 5.0, y: 1.0, w: 4.5, h: 3.5,
//   sizing: { type: "contain", w: 4.5, h: 3.5 },
// });
```

---

## Layout 5: icon-grid-3x2 (图标网格 3x2)

6 items in a 3-column, 2-row grid.
Each item has a colored circle with icon, bold title, and description.
Dark background with light text.

**Use when**: feature overview, service offerings, team capabilities.

```
+------------------------------------------+
|                                          |
|  (o) Title 1   (o) Title 2   (o) Title 3|
|   Desc text     Desc text     Desc text  |
|                                          |
|  (o) Title 4   (o) Title 5   (o) Title 6|
|   Desc text     Desc text     Desc text  |
|                                          |
+------------------------------------------+
```

```javascript
// --- Layout 5: icon-grid-3x2 ---
const slide = pres.addSlide();
slide.background = { color: THEME.colors.bg_dark };

// Slide title (optional, top area)
slide.addText(titleText, {
  x: 0.5, y: 0.3, w: 9, h: 0.6,
  ...THEME.titleStyle({
    fontSize: 28,
    color: THEME.colors.text_on_dark,
    align: "left",
  }),
});

// Grid items data
const items = [
  { icon: icon1Data, title: "Feature One", desc: "Brief description of the first feature" },
  { icon: icon2Data, title: "Feature Two", desc: "Brief description of the second feature" },
  { icon: icon3Data, title: "Feature Three", desc: "Brief description of the third feature" },
  { icon: icon4Data, title: "Feature Four", desc: "Brief description of the fourth feature" },
  { icon: icon5Data, title: "Feature Five", desc: "Brief description of the fifth feature" },
  { icon: icon6Data, title: "Feature Six", desc: "Brief description of the sixth feature" },
];

const cols = 3;
const colW = 2.8;
const rowH = 2.0;
const startX = 0.7;
const startY = 1.2;
const gapX = 0.35;

items.forEach((item, i) => {
  const col = i % cols;
  const row = Math.floor(i / cols);
  const x = startX + col * (colW + gapX);
  const y = startY + row * rowH;

  // Colored circle background for icon
  slide.addShape(pres.shapes.OVAL, {
    x: x + 0.05, y: y, w: 0.5, h: 0.5,
    fill: { color: THEME.colors.accent, transparency: 20 },
  });

  // Icon image inside circle
  slide.addImage({
    data: item.icon,
    x: x + 0.1, y: y + 0.05, w: 0.4, h: 0.4,
  });

  // Item title (bold)
  slide.addText(item.title, {
    x: x, y: y + 0.6, w: colW, h: 0.4,
    ...THEME.subtitleStyle({
      fontSize: 16,
      color: THEME.colors.text_on_dark,
      align: "left",
      bold: true,
    }),
  });

  // Item description
  slide.addText(item.desc, {
    x: x, y: y + 1.0, w: colW, h: 0.7,
    ...THEME.captionStyle({
      fontSize: 12,
      color: THEME.colors.text_muted,
      align: "left",
      valign: "top",
    }),
  });
});
```

---

## Layout 6: comparison-columns (对比栏)

2 or 3 columns side by side, each with a colored header bar and content below.
Optional checkmark/cross indicators.

**Use when**: comparing plans, options, before/after, pros/cons.

```
+------------------------------------------+
|   COMPARISON TITLE                       |
|  +-----------+ +-----------+ +---------+ |
|  | Header A  | | Header B  | | Header C| |
|  +-----------+ +-----------+ +---------+ |
|  | Content   | | Content   | | Content | |
|  | - item 1  | | - item 1  | | - item 1| |
|  | - item 2  | | - item 2  | | - item 2| |
|  +-----------+ +-----------+ +---------+ |
+------------------------------------------+
```

```javascript
// --- Layout 6: comparison-columns ---
const slide = pres.addSlide();
slide.background = { color: THEME.colors.bg_light };

// Slide title
slide.addText(titleText, {
  x: 0.5, y: 0.3, w: 9, h: 0.6,
  ...THEME.titleStyle({
    fontSize: 28,
    color: THEME.colors.text_on_light,
    align: "left",
  }),
});

// Column data
const columns = [
  {
    header: "Basic Plan",
    headerColor: THEME.colors.secondary,
    items: ["5 GB Storage", "Email support", "1 user"],
  },
  {
    header: "Pro Plan",
    headerColor: THEME.colors.primary,
    items: ["50 GB Storage", "Priority support", "5 users", "API access"],
  },
  {
    header: "Enterprise",
    headerColor: THEME.colors.accent,
    items: ["Unlimited Storage", "Dedicated support", "Unlimited users", "Custom API"],
  },
];

const colCount = columns.length;
const totalW = 9.0;
const gap = 0.3;
const colW = (totalW - gap * (colCount - 1)) / colCount;
const colStartX = 0.5;
const colStartY = 1.2;
const headerH = 0.6;
const bodyH = 3.4;

columns.forEach((col, i) => {
  const x = colStartX + i * (colW + gap);

  // Header bar (filled rectangle)
  slide.addShape(pres.shapes.RECTANGLE, {
    x: x, y: colStartY, w: colW, h: headerH,
    fill: { color: col.headerColor },
  });

  // Header text
  slide.addText(col.header, {
    x: x, y: colStartY, w: colW, h: headerH,
    ...THEME.subtitleStyle({
      fontSize: 18,
      color: THEME.colors.text_on_dark,
      align: "center",
      valign: "middle",
    }),
  });

  // Content card below header
  slide.addShape(pres.shapes.RECTANGLE, {
    x: x, y: colStartY + headerH, w: colW, h: bodyH,
    fill: { color: THEME.colors.card_bg },
    shadow: THEME.cardShadow(),
  });

  // Bullet items
  const bulletItems = col.items.map((text, j) => ({
    text: text,
    options: {
      bullet: true,
      ...(j < col.items.length - 1 ? { breakLine: true } : {}),
    },
  }));

  slide.addText(bulletItems, {
    x: x + 0.2, y: colStartY + headerH + 0.2, w: colW - 0.4, h: bodyH - 0.4,
    ...THEME.bodyStyle({
      fontSize: 14,
      color: THEME.colors.text_on_light,
      align: "left",
      valign: "top",
      lineSpacingMultiple: 1.5,
    }),
  });
});
```

---

## Layout 7: timeline-horizontal (水平时间线)

Horizontal line across the slide with circular nodes.
Year/date above each node, description below.

**Use when**: project milestones, company history, roadmap, process phases.

```
+------------------------------------------+
|   TIMELINE TITLE                         |
|                                          |
|   2020       2021       2022       2023  |
|    (o)---------(o)---------(o)--------(o)|
|   Founded   Series A   Launch    IPO     |
|   desc       desc       desc     desc    |
+------------------------------------------+
```

```javascript
// --- Layout 7: timeline-horizontal ---
const slide = pres.addSlide();
slide.background = { color: THEME.colors.bg_dark };

// Title
slide.addText(titleText, {
  x: 0.5, y: 0.3, w: 9, h: 0.6,
  ...THEME.titleStyle({
    fontSize: 28,
    color: THEME.colors.text_on_dark,
    align: "left",
  }),
});

// Timeline data
const nodes = [
  { year: "2020", title: "Founded", desc: "Company established in Silicon Valley" },
  { year: "2021", title: "Series A", desc: "Raised $10M in funding" },
  { year: "2022", title: "Launch", desc: "Product launched globally" },
  { year: "2023", title: "Scale", desc: "Reached 1M users" },
];

const lineY = 2.8;
const startX = 1.0;
const endX = 9.0;
const nodeSpacing = (endX - startX) / (nodes.length - 1);

// Horizontal line
slide.addShape(pres.shapes.LINE, {
  x: startX, y: lineY, w: endX - startX, h: 0,
  line: { color: THEME.colors.text_muted, width: 2 },
});

nodes.forEach((node, i) => {
  const x = startX + i * nodeSpacing;

  // Node circle
  slide.addShape(pres.shapes.OVAL, {
    x: x - 0.15, y: lineY - 0.15, w: 0.3, h: 0.3,
    fill: { color: THEME.colors.accent },
  });

  // Year/date label (above the line)
  slide.addText(node.year, {
    x: x - 0.8, y: lineY - 1.0, w: 1.6, h: 0.5,
    ...THEME.subtitleStyle({
      fontSize: 20,
      color: THEME.colors.accent,
      align: "center",
      valign: "bottom",
      bold: true,
    }),
  });

  // Title (below the line)
  slide.addText(node.title, {
    x: x - 0.8, y: lineY + 0.3, w: 1.6, h: 0.4,
    ...THEME.subtitleStyle({
      fontSize: 16,
      color: THEME.colors.text_on_dark,
      align: "center",
      valign: "top",
      bold: true,
    }),
  });

  // Description (below title)
  slide.addText(node.desc, {
    x: x - 0.9, y: lineY + 0.7, w: 1.8, h: 0.8,
    ...THEME.captionStyle({
      fontSize: 11,
      color: THEME.colors.text_muted,
      align: "center",
      valign: "top",
    }),
  });
});
```

---

## Layout 8: quote-emphasis (引言强调页)

Large decorative quote marks with italic quote text.
Attribution right-aligned below. Minimal dark background.

**Use when**: customer testimonial, expert quote, inspirational statement.

```
+------------------------------------------+
|                                          |
|     "                                    |
|     The best way to predict the future   |
|     is to create it.                     |
|                                    "     |
|                        -- Peter Drucker  |
|                                          |
+------------------------------------------+
```

```javascript
// --- Layout 8: quote-emphasis ---
const slide = pres.addSlide();
slide.background = { color: THEME.colors.bg_dark };

// Opening quote mark (decorative, large)
slide.addText("\u201C", {
  x: 0.8, y: 0.8, w: 1.5, h: 1.5,
  fontFace: THEME.fonts.accent,
  fontSize: 120,
  color: THEME.colors.accent,
  bold: true,
  margin: 0,
  valign: "top",
});

// Quote text (italic, large)
slide.addText(quoteText, {
  x: 1.5, y: 1.8, w: 7.0, h: 2.0,
  ...THEME.bodyStyle({
    fontSize: 24,
    color: THEME.colors.text_on_dark,
    italic: true,
    align: "left",
    valign: "middle",
    lineSpacingMultiple: 1.5,
  }),
});

// Closing quote mark (decorative)
slide.addText("\u201D", {
  x: 7.5, y: 3.2, w: 1.5, h: 1.5,
  fontFace: THEME.fonts.accent,
  fontSize: 120,
  color: THEME.colors.accent,
  bold: true,
  margin: 0,
  valign: "top",
});

// Attribution line (right-aligned)
slide.addText("-- " + authorName, {
  x: 3.0, y: 4.2, w: 6.0, h: 0.5,
  ...THEME.captionStyle({
    fontSize: 16,
    color: THEME.colors.text_muted,
    align: "right",
    valign: "top",
  }),
});
```

---

## Layout 9: image-gallery-grid (图片画廊 2x2)

4 images in a 2x2 grid with equal spacing.
Small caption below each image. Uniform sizing with `cover` mode.

**Use when**: photo gallery, product showcase, team photos, portfolio.

```
+------------------------------------------+
|   GALLERY TITLE                          |
|  +----------+    +----------+            |
|  | image 1  |    | image 2  |            |
|  +----------+    +----------+            |
|   Caption 1       Caption 2              |
|  +----------+    +----------+            |
|  | image 3  |    | image 4  |            |
|  +----------+    +----------+            |
|   Caption 3       Caption 4              |
+------------------------------------------+
```

```javascript
// --- Layout 9: image-gallery-grid ---
const slide = pres.addSlide();
slide.background = { color: THEME.colors.bg_light };

// Title
slide.addText(titleText, {
  x: 0.5, y: 0.2, w: 9, h: 0.5,
  ...THEME.titleStyle({
    fontSize: 24,
    color: THEME.colors.text_on_light,
    align: "left",
  }),
});

// Gallery data
const gallery = [
  { path: image1Path, caption: "Caption for image one" },
  { path: image2Path, caption: "Caption for image two" },
  { path: image3Path, caption: "Caption for image three" },
  { path: image4Path, caption: "Caption for image four" },
];

const gridCols = 2;
const imgW = 4.0;
const imgH = 1.8;
const captionH = 0.35;
const gap = 0.5;
const gridStartX = 0.5;
const gridStartY = 0.9;

gallery.forEach((item, i) => {
  const col = i % gridCols;
  const row = Math.floor(i / gridCols);
  const x = gridStartX + col * (imgW + gap);
  const y = gridStartY + row * (imgH + captionH + gap);

  // Image with cover sizing
  slide.addImage({
    path: item.path,
    x: x, y: y, w: imgW, h: imgH,
    sizing: { type: "cover", w: imgW, h: imgH },
  });

  // Caption below image
  slide.addText(item.caption, {
    x: x, y: y + imgH + 0.05, w: imgW, h: captionH,
    ...THEME.captionStyle({
      fontSize: 11,
      color: THEME.colors.text_muted,
      align: "center",
      valign: "top",
    }),
  });
});
```

---

## Layout 10: stats-dashboard (数据仪表盘)

3-4 KPI cards in a row, each a white rounded rectangle with
large number, label, and trend indicator. Cards have shadow.

**Use when**: dashboard summary, quarterly results, performance metrics.

```
+------------------------------------------+
|   DASHBOARD TITLE                        |
|  +--------+  +--------+  +--------+     |
|  |  $2.4M |  |  87%   |  |  1.2K  |     |
|  | Revenue|  | Growth |  | Users  |     |
|  | +12.5% |  | +5.3%  |  | +340   |     |
|  +--------+  +--------+  +--------+     |
|                                          |
+------------------------------------------+
```

```javascript
// --- Layout 10: stats-dashboard ---
const slide = pres.addSlide();
slide.background = { color: THEME.colors.bg_dark };

// Title
slide.addText(titleText, {
  x: 0.5, y: 0.3, w: 9, h: 0.6,
  ...THEME.titleStyle({
    fontSize: 28,
    color: THEME.colors.text_on_dark,
    align: "left",
  }),
});

// KPI data
const kpis = [
  { value: "$2.4M", label: "Revenue", trend: "+12.5%" },
  { value: "87%", label: "Conversion", trend: "+5.3%" },
  { value: "1.2K", label: "New Users", trend: "+340" },
];

const cardCount = kpis.length;
const totalW = 9.0;
const cardGap = 0.4;
const cardW = (totalW - cardGap * (cardCount - 1)) / cardCount;
const cardH = 3.0;
const cardStartX = 0.5;
const cardStartY = 1.4;

kpis.forEach((kpi, i) => {
  const x = cardStartX + i * (cardW + cardGap);

  // Card background (white rounded rectangle with shadow)
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: x, y: cardStartY, w: cardW, h: cardH,
    fill: { color: THEME.colors.card_bg },
    rectRadius: 0.1,
    shadow: THEME.cardShadow(),
  });

  // Large KPI value
  slide.addText(kpi.value, {
    x: x, y: cardStartY + 0.3, w: cardW, h: 1.2,
    ...THEME.titleStyle({
      fontSize: 44,
      color: THEME.colors.primary,
      align: "center",
      valign: "middle",
      bold: true,
    }),
  });

  // KPI label
  slide.addText(kpi.label, {
    x: x, y: cardStartY + 1.5, w: cardW, h: 0.5,
    ...THEME.bodyStyle({
      fontSize: 16,
      color: THEME.colors.text_muted,
      align: "center",
      valign: "middle",
    }),
  });

  // Trend indicator
  slide.addText(kpi.trend, {
    x: x, y: cardStartY + 2.1, w: cardW, h: 0.5,
    ...THEME.captionStyle({
      fontSize: 14,
      color: THEME.colors.accent,
      align: "center",
      valign: "middle",
      bold: true,
    }),
  });
});
```

---

## Layout 11: process-flow (流程步骤)

4-5 horizontal steps with numbered circles, titles, descriptions.
Arrow shapes connect the steps.

**Use when**: workflow, onboarding steps, methodology, how-it-works.

```
+------------------------------------------+
|   PROCESS TITLE                          |
|                                          |
|   (1) ---> (2) ---> (3) ---> (4)        |
|  Step 1   Step 2   Step 3   Step 4       |
|   desc     desc     desc     desc        |
|                                          |
+------------------------------------------+
```

```javascript
// --- Layout 11: process-flow ---
const slide = pres.addSlide();
slide.background = { color: THEME.colors.bg_light };

// Title
slide.addText(titleText, {
  x: 0.5, y: 0.3, w: 9, h: 0.6,
  ...THEME.titleStyle({
    fontSize: 28,
    color: THEME.colors.text_on_light,
    align: "left",
  }),
});

// Steps data
const steps = [
  { num: "1", title: "Research", desc: "Gather requirements and analyze market data" },
  { num: "2", title: "Design", desc: "Create wireframes and visual prototypes" },
  { num: "3", title: "Build", desc: "Develop the solution with agile sprints" },
  { num: "4", title: "Launch", desc: "Deploy, monitor, and iterate on feedback" },
];

const stepCount = steps.length;
const totalW = 9.0;
const stepGap = 0.5;
const arrowW = 0.6;
const stepW = (totalW - arrowW * (stepCount - 1) - stepGap * (stepCount - 1)) / stepCount;
const circleSize = 0.6;
const stepStartX = 0.5;
const stepY = 1.8;

steps.forEach((step, i) => {
  const x = stepStartX + i * (stepW + arrowW + stepGap);

  // Numbered circle
  slide.addShape(pres.shapes.OVAL, {
    x: x + (stepW - circleSize) / 2,
    y: stepY,
    w: circleSize,
    h: circleSize,
    fill: { color: THEME.colors.accent },
  });

  // Number inside circle
  slide.addText(step.num, {
    x: x + (stepW - circleSize) / 2,
    y: stepY,
    w: circleSize,
    h: circleSize,
    fontFace: THEME.fonts.title,
    fontSize: 22,
    color: THEME.colors.text_on_dark,
    bold: true,
    align: "center",
    valign: "middle",
    margin: 0,
  });

  // Step title
  slide.addText(step.title, {
    x: x, y: stepY + circleSize + 0.2, w: stepW, h: 0.4,
    ...THEME.subtitleStyle({
      fontSize: 16,
      color: THEME.colors.text_on_light,
      align: "center",
      valign: "top",
      bold: true,
    }),
  });

  // Step description
  slide.addText(step.desc, {
    x: x, y: stepY + circleSize + 0.65, w: stepW, h: 1.2,
    ...THEME.captionStyle({
      fontSize: 11,
      color: THEME.colors.text_muted,
      align: "center",
      valign: "top",
    }),
  });

  // Arrow between steps (except after the last one)
  if (i < stepCount - 1) {
    const arrowX = x + stepW + stepGap * 0.1;
    const arrowY = stepY + circleSize / 2;
    slide.addShape(pres.shapes.LINE, {
      x: arrowX,
      y: arrowY,
      w: arrowW + stepGap * 0.8,
      h: 0,
      line: {
        color: THEME.colors.text_muted,
        width: 2,
        endArrowType: "triangle",
      },
    });
  }
});
```

---

## Layout 12: closing (结尾页)

Dark background matching cover theme.
Large "Thank You" or custom message, subtitle with contact info.
Accent color decorative element.

**Use when**: last slide, closing, call to action, contact info.

```
+------------------------------------------+
|                                          |
|             THANK YOU                    |
|                                          |
|        Let's build the future.           |
|                                          |
|       email@company.com | @handle        |
|  ========================================|
+------------------------------------------+
  (accent bar at bottom)
```

```javascript
// --- Layout 12: closing ---
const slide = pres.addSlide();
slide.background = { color: THEME.colors.bg_dark };

// Decorative accent bar at bottom
slide.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 5.225, w: 10, h: 0.4,
  fill: { color: THEME.colors.accent },
});

// Main message (large, centered)
slide.addText(closingTitle, {
  x: 1, y: 1.2, w: 8, h: 1.5,
  ...THEME.titleStyle({
    fontSize: 48,
    color: THEME.colors.text_on_dark,
    align: "center",
    valign: "middle",
  }),
});

// Subtitle / tagline
slide.addText(closingSubtitle, {
  x: 1.5, y: 2.9, w: 7, h: 0.8,
  ...THEME.subtitleStyle({
    fontSize: 20,
    color: THEME.colors.text_muted,
    align: "center",
    valign: "middle",
    bold: false,
  }),
});

// Contact info
slide.addText(contactInfo, {
  x: 1.5, y: 4.0, w: 7, h: 0.6,
  ...THEME.captionStyle({
    fontSize: 14,
    color: THEME.colors.text_muted,
    align: "center",
    valign: "middle",
  }),
});

// Small accent circle (decorative)
slide.addShape(pres.shapes.OVAL, {
  x: 4.7, y: 0.5, w: 0.6, h: 0.6,
  fill: { color: THEME.colors.accent, transparency: 30 },
});
```

---

## Bonus Layout A: section-divider (章节分隔页)

Large section number and title on a dark background.
Minimal and bold, used to separate major sections.

**Use when**: transitioning between major presentation sections.

```
+------------------------------------------+
|                                          |
|       02                                 |
|       MARKET ANALYSIS                    |
|       Brief section description          |
|                                          |
+------------------------------------------+
```

```javascript
// --- Bonus Layout A: section-divider ---
const slide = pres.addSlide();
slide.background = { color: THEME.colors.primary };

// Left accent bar
slide.addShape(pres.shapes.RECTANGLE, {
  ...THEME.accentBar({ x: 0, y: 0, w: 0.12, h: 5.625 }),
});

// Section number (large, accent)
slide.addText(sectionNumber, {
  x: 0.8, y: 1.2, w: 8, h: 1.5,
  ...THEME.titleStyle({
    fontSize: 72,
    color: THEME.colors.accent,
    align: "left",
    valign: "bottom",
    bold: true,
  }),
});

// Section title
slide.addText(sectionTitle, {
  x: 0.8, y: 2.7, w: 8, h: 0.8,
  ...THEME.titleStyle({
    fontSize: 36,
    color: THEME.colors.text_on_dark,
    align: "left",
    valign: "top",
  }),
});

// Brief description
slide.addText(sectionDesc, {
  x: 0.8, y: 3.5, w: 6, h: 0.6,
  ...THEME.bodyStyle({
    fontSize: 16,
    color: THEME.colors.text_on_dark,
    align: "left",
    valign: "top",
    bold: false,
  }),
});
```

---

## Bonus Layout B: two-stat-split (双数据对比页)

Two large statistics side by side, each in its own half.
Visual separation with a vertical divider line.

**Use when**: before/after comparison, two competing metrics, A/B test results.

```
+------------------------------------------+
|   COMPARISON TITLE                       |
|                    |                      |
|     42%            |       78%            |
|    Before          |      After           |
|   description      |    description       |
|                    |                      |
+------------------------------------------+
```

```javascript
// --- Bonus Layout B: two-stat-split ---
const slide = pres.addSlide();
slide.background = { color: THEME.colors.bg_dark };

// Title
slide.addText(titleText, {
  x: 0.5, y: 0.3, w: 9, h: 0.5,
  ...THEME.titleStyle({
    fontSize: 24,
    color: THEME.colors.text_on_dark,
    align: "left",
  }),
});

// Vertical divider
slide.addShape(pres.shapes.LINE, {
  x: 5.0, y: 1.2, w: 0, h: 3.6,
  line: { color: THEME.colors.text_muted, width: 1 },
});

// Left stat
slide.addText(leftValue, {
  x: 0.5, y: 1.5, w: 4.0, h: 1.5,
  ...THEME.titleStyle({
    fontSize: 64,
    color: THEME.colors.secondary,
    align: "center",
    valign: "bottom",
  }),
});

slide.addText(leftLabel, {
  x: 0.5, y: 3.0, w: 4.0, h: 0.5,
  ...THEME.subtitleStyle({
    fontSize: 18,
    color: THEME.colors.text_on_dark,
    align: "center",
    valign: "top",
    bold: true,
  }),
});

slide.addText(leftDesc, {
  x: 0.5, y: 3.5, w: 4.0, h: 0.8,
  ...THEME.captionStyle({
    fontSize: 13,
    color: THEME.colors.text_muted,
    align: "center",
    valign: "top",
  }),
});

// Right stat
slide.addText(rightValue, {
  x: 5.5, y: 1.5, w: 4.0, h: 1.5,
  ...THEME.titleStyle({
    fontSize: 64,
    color: THEME.colors.accent,
    align: "center",
    valign: "bottom",
  }),
});

slide.addText(rightLabel, {
  x: 5.5, y: 3.0, w: 4.0, h: 0.5,
  ...THEME.subtitleStyle({
    fontSize: 18,
    color: THEME.colors.text_on_dark,
    align: "center",
    valign: "top",
    bold: true,
  }),
});

slide.addText(rightDesc, {
  x: 5.5, y: 3.5, w: 4.0, h: 0.8,
  ...THEME.captionStyle({
    fontSize: 13,
    color: THEME.colors.text_muted,
    align: "center",
    valign: "top",
  }),
});
```

---

## Quick Reference (速查表)

| # | Layout Name | Chinese Name | Best For |
|---|-------------|-------------|----------|
| 1 | cover-fullbleed | 封面 - 全屏背景图 | Opening slide, hero image |
| 2 | toc-numbered | 目录页 | Agenda, table of contents |
| 3 | content-split | 内容双栏 - 左文右图 | Main content with visual |
| 4 | data-highlight | 数据突出 | Single key metric |
| 5 | icon-grid-3x2 | 图标网格 3x2 | Feature grid, services |
| 6 | comparison-columns | 对比栏 | Plans, options, pros/cons |
| 7 | timeline-horizontal | 水平时间线 | Milestones, roadmap |
| 8 | quote-emphasis | 引言强调页 | Testimonial, quote |
| 9 | image-gallery-grid | 图片画廊 2x2 | Photo gallery, portfolio |
| 10 | stats-dashboard | 数据仪表盘 | KPI cards, dashboard |
| 11 | process-flow | 流程步骤 | Workflow, how-it-works |
| 12 | closing | 结尾页 | Thank you, contact info |
| A | section-divider | 章节分隔页 | Section transitions |
| B | two-stat-split | 双数据对比页 | Before/after, A/B compare |

### Layout Selection Tips (版式选择建议)

- **Avoid monotony**: Never use the same layout for consecutive slides
- **Match content type**: bullets -> content-split; numbers -> data-highlight or stats-dashboard
- **Visual density**: Alternate between text-heavy and visual-heavy layouts
- **Breathing room**: Use section-divider or quote-emphasis between dense content sections
- **Every content slide**: At least 2 visual elements (image, chart, icon, or shape)
