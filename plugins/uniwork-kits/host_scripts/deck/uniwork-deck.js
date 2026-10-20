'use strict'
/**
 * 宿主自带的 PPT 版式库（uniwork-kits）。
 *
 * 模型选一套风格，按页调用版式函数填内容；坐标、字号、图片比例、页码都由这里算好，
 * 不用每份 PPT 从头写一遍版式（2026-10-20 实测：20 页 PPT 里自己写公共版式要十分钟以上，
 * 还常出 PowerPoint 打不开的形状名、负高度、图片拉伸、文字溢出）。用法见同目录 README.md。
 *
 * 只用 pptxgenjs 自带的东西：调用方把 PptxGenJS 传进来，用的是它项目里装的那一份。
 * 页面 13.333×7.5 英寸（LAYOUT_WIDE），坐标全用英寸；页码放左下角，避开生成图右下角的水印。
 */
const fs = require('fs')

const W = 13.333
const H = 7.5
const SIDE = 0.6
const FONT = 'Microsoft YaHei'
const CONTENT_TOP = 1.9
const CONTENT_BOTTOM = 6.8

// 风格：dark 用于封面、章节页、结尾，light 用于正文页。accent 是强调色，accent2 是第二强调色，
// accentOnDark 是深色页上的强调色（有的风格强调色和深色底太接近，放在深色页上看不清）。
const THEMES = {
  'navy-teal': { name: '深海蓝·青', dark: '0D1B2A', light: 'F4F7FA', card: 'FFFFFF', primary: '12324F', accent: '14A3A8', accent2: 'F2994A', text: '1C2B3A', muted: '64748B', line: 'D9E2EC', onDark: 'FFFFFF', onDarkMuted: 'A9B8C9', accentOnDark: '2CC4C9' },
  'ink-gold': { name: '墨黑·金', dark: '16151A', light: 'F7F5F0', card: 'FFFFFF', primary: '232129', accent: 'C9A227', accent2: '5B7083', text: '232129', muted: '6E6A60', line: 'E4DED0', onDark: 'FFFFFF', onDarkMuted: 'BDB6A6', accentOnDark: 'D9B23A' },
  'china-red': { name: '中国红', dark: '8E1B1B', light: 'FBF6EF', card: 'FFFFFF', primary: 'A61E22', accent: 'C8102E', accent2: 'D4A017', text: '2B1D1A', muted: '7A6A62', line: 'EADCCB', onDark: 'FFFFFF', onDarkMuted: 'F2D6CF', accentOnDark: 'F2C14E' },
  'forest-green': { name: '森林绿', dark: '123524', light: 'F3F7F2', card: 'FFFFFF', primary: '1E5631', accent: '3FA34D', accent2: 'E0A526', text: '1D2B22', muted: '5F7366', line: 'D6E4D8', onDark: 'FFFFFF', onDarkMuted: 'B5CDBB', accentOnDark: '6CC47A' },
  'ocean-light': { name: '浅海蓝', dark: '1F4E79', light: 'FFFFFF', card: 'F3F7FB', primary: '1F4E79', accent: '2E86DE', accent2: '00B894', text: '1E2A36', muted: '6B7A8A', line: 'DCE6F0', onDark: 'FFFFFF', onDarkMuted: 'C8D9EB', accentOnDark: '7CC4FF' },
  'graphite-orange': { name: '石墨·橙', dark: '22262B', light: 'F5F5F4', card: 'FFFFFF', primary: '2F3439', accent: 'F07D19', accent2: '3B82B5', text: '22262B', muted: '6B6F74', line: 'DEDEDC', onDark: 'FFFFFF', onDarkMuted: 'B9BCC0', accentOnDark: 'F59A45' },
  'tech-purple': { name: '科技紫', dark: '1B1238', light: 'F6F5FB', card: 'FFFFFF', primary: '2D1B69', accent: '7C5CFF', accent2: '22D3EE', text: '1F1A33', muted: '6A6584', line: 'E1DCF2', onDark: 'FFFFFF', onDarkMuted: 'BDB3E6', accentOnDark: '9B87FF' },
  'warm-sand': { name: '暖沙', dark: '4A3426', light: 'FAF6F0', card: 'FFFFFF', primary: '6B4A35', accent: 'C46A3A', accent2: '7FA36B', text: '3A2A20', muted: '857161', line: 'EADFD2', onDark: 'FFFFFF', onDarkMuted: 'E3D2C2', accentOnDark: 'E8A56F' },
  'minimal-mono': { name: '极简黑白', dark: '111111', light: 'FFFFFF', card: 'F5F5F5', primary: '111111', accent: '2563EB', accent2: '4B5563', text: '111111', muted: '6B7280', line: 'E5E7EB', onDark: 'FFFFFF', onDarkMuted: 'B7BCC4', accentOnDark: '60A5FA' },
  'sky-education': { name: '教育天蓝', dark: '0B5394', light: 'F5FAFF', card: 'FFFFFF', primary: '0B5394', accent: '2F9BEF', accent2: 'F6B800', text: '1B2C3D', muted: '647789', line: 'D6E6F5', onDark: 'FFFFFF', onDarkMuted: 'C3DCF2', accentOnDark: 'F6B800' }
}

// ── 文字和图片的计算 ─────────────────────────────────────────────────────────

/** 一段文字的大致宽度（以字号为单位）：汉字和全角符号算 1，西文按字形宽窄估。 */
function emWidth(text) {
  let width = 0
  for (const ch of String(text)) {
    const code = ch.codePointAt(0)
    if (code > 0x2e7f) width += 1
    else if (ch === ' ') width += 0.5
    else if (/[A-Z0-9%]/.test(ch)) width += 0.62
    else width += 0.52
  }
  return width
}

// 一行按能放下的字数打九三折估算：刚好卡在一行边上的文字，PowerPoint 常因标点不能放行首而折行，
// 宿主的版面检查（西文统一按半个字宽算）也会判成两行；不留余量，卡片就会少留一行高度而被退回（2026-10-20 实测）。
const WRAP_SLACK = 0.93

/** 文字在给定宽度（英寸）、字号（磅）下要占几行。 */
function lineCount(text, boxW, pt) {
  const perLine = Math.max(1, ((boxW * 72) / pt) * WRAP_SLACK)
  return String(text)
    .split('\n')
    .reduce((n, para) => n + Math.max(1, Math.ceil(emWidth(para) / perLine)), 0)
}

// PowerPoint 的单倍行距约是字号的 1.2 倍，行距倍数（lineSpacingMultiple）在这个基础上再乘。
const SINGLE_LINE = 1.2
const SPACING = 1.15

/** 文字在给定宽度、字号、行距倍数下实际占的高度（英寸）。 */
function textHeight(text, boxW, pt, spacing = SPACING) {
  return (lineCount(text, boxW, pt) * pt * spacing * SINGLE_LINE) / 72
}

/** 在 maxPt 到 minPt 之间，找能把文字完整放进框里的最大字号。 */
function fitPt(text, boxW, boxH, maxPt, minPt, spacing = SPACING) {
  for (let pt = maxPt; pt > minPt; pt -= 1) {
    if (textHeight(text, boxW, pt, spacing) <= boxH) return pt
  }
  return minPt
}

/** 同一组并列的文字（几张卡片的正文、几个步骤的说明）用同一个字号：取每段各自能放下的最大字号里最小的那个。 */
function fitGroup(texts, boxW, boxH, maxPt, minPt, spacing = SPACING) {
  const filled = texts.map(t => String(t ?? '')).filter(t => t.trim())
  return filled.length ? Math.min(...filled.map(t => fitPt(t, boxW, boxH, maxPt, minPt, spacing))) : maxPt
}

/** 一组文字在同一字号下最高的那段有多高（英寸）。 */
function groupHeight(texts, boxW, pt, spacing = SPACING) {
  return Math.max(0, ...texts.map(t => String(t ?? '')).filter(t => t.trim()).map(t => textHeight(t, boxW, pt, spacing)))
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

/** 读 PNG、JPEG、GIF 文件头里的像素宽高；读不出返回 null（按 16:9 处理）。 */
function imageSize(file) {
  let b
  try {
    b = fs.readFileSync(file)
  } catch (error) {
    throw new Error(`图片读不到：${file}（${error.message}）`)
  }
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  if (b.length > 10 && b.toString('ascii', 0, 4) === 'GIF8') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1
        continue
      }
      const marker = b[i + 1]
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) }
      }
      i += 2 + b.readUInt16BE(i + 2)
    }
  }
  return null
}

/** 把图片按原比例完整放进框里（contain）：返回居中后的位置和大小，不拉伸、不裁切，水印也留在画面里。 */
function containBox(file, x, y, w, h) {
  const size = imageSize(file) || { w: 16, h: 9 }
  const ratio = size.w / size.h
  let dw = w
  let dh = w / ratio
  if (dh > h) {
    dh = h
    dw = h * ratio
  }
  return { x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh }
}

/** 英寸保留三位小数，pptxgenjs 换算成整数 EMU，不会出现小数坐标。 */
const r3 = value => Math.round(value * 1000) / 1000

/** 版式函数参数里的一条要点：可以是字符串，也可以是 { head, text }；对象和数组之外的值转成字符串。 */
function asPoint(item) {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    return { head: String(item.head ?? item.title ?? ''), text: String(item.text ?? item.desc ?? '') }
  }
  return { head: '', text: Array.isArray(item) ? item.join('、') : String(item ?? '') }
}

/** 参数里必须是数组的地方，传错了就直接报错，免得把 [object Object] 写进页面。 */
function needList(value, name, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${name} 要传 ${min}～${max} 项的数组，现在是：${JSON.stringify(value)?.slice(0, 120)}`)
  }
  return value
}

/** 版式函数里不该是对象的地方（标题、数值、单元格）：传了对象或数组就报错，其余转成字符串。 */
function asText(value, name) {
  if (value !== null && typeof value === 'object') {
    throw new Error(`${name} 要传文字，现在传的是：${JSON.stringify(value)?.slice(0, 120)}`)
  }
  return value === undefined || value === null ? '' : String(value)
}

/**
 * 新建一份 PPT。PptxGenJS 是调用方 require('pptxgenjs') 得到的类；options：
 * theme（风格名，见 THEMES）、title（PPT 标题，也印在每页页脚）、author、footer（页脚文字，默认用 title）。
 */
function createDeck(PptxGenJS, options = {}) {
  if (options.theme && !THEMES[options.theme]) {
    throw new Error(`没有这套风格：${options.theme}。可选：${Object.keys(THEMES).join('、')}`)
  }
  const theme = THEMES[options.theme || 'navy-teal']
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.title = asText(options.title, 'title')
  pptx.author = asText(options.author, 'author')
  const footer = asText(options.footer ?? options.title, 'footer')
  const pages = []
  const area = { x: SIDE, y: CONTENT_TOP, w: W - 2 * SIDE, h: CONTENT_BOTTOM - CONTENT_TOP }

  /** 加一页：dark 用深色底（封面、章节、结尾），numbered 决定保存时要不要印页码。 */
  function newSlide({ dark = false, numbered = true } = {}) {
    const slide = pptx.addSlide()
    slide.background = { color: dark ? theme.dark : theme.light }
    pages.push({ slide, dark, numbered })
    return slide
  }

  /** 写一段文字：没给 pt 就在 maxPt～minPt 里挑能放下的最大字号。返回实际字号；空文字不写。 */
  function text(slide, value, box, o = {}) {
    const s = asText(value, '文字')
    if (!s.trim()) return 0
    const spacing = o.spacing || SPACING
    const pt = o.pt || fitPt(s, box.w, box.h, o.maxPt || 16, o.minPt || Math.min(o.maxPt || 16, 10), spacing)
    slide.addText(s, {
      x: r3(box.x), y: r3(box.y), w: r3(box.w), h: r3(box.h),
      fontFace: FONT, fontSize: pt, color: o.color || theme.text, bold: Boolean(o.bold),
      align: o.align || 'left', valign: o.valign || 'top', margin: 0,
      lineSpacingMultiple: spacing, paraSpaceAfter: 0
    })
    return pt
  }

  /** 画一个色块（round 为圆角，line 为描边色）。每次都新建参数对象，pptxgenjs 会原地改写传进去的对象。 */
  function rect(slide, box, color, o = {}) {
    const props = { x: r3(box.x), y: r3(box.y), w: r3(box.w), h: r3(box.h), fill: { color } }
    if (o.line) props.line = { color: o.line, width: 0.75 }
    if (o.round) props.rectRadius = 0.08
    slide.addShape(o.round ? 'roundRect' : 'rect', props)
  }

  /** 画圆点或只有边线的圆环（ring 为真时填充全透明，不挡字）。 */
  function circle(slide, box, color, o = {}) {
    const props = { x: r3(box.x), y: r3(box.y), w: r3(box.w), h: r3(box.h) }
    props.fill = o.ring ? { color, transparency: 100 } : { color }
    if (o.ring) props.line = { color, width: o.width || 1.5, transparency: o.transparency || 0 }
    slide.addShape('ellipse', props)
  }

  /** 把图片按原比例放进相框，相框底色补齐空白；source 写在相框正下方左侧（不碰右下角的水印）。 */
  function picture(slide, file, frame, o = {}) {
    const path = asText(file, 'image')
    if (o.frameColor) rect(slide, frame, o.frameColor)
    const box = containBox(path, frame.x, frame.y, frame.w, frame.h)
    slide.addImage({ path, x: r3(box.x), y: r3(box.y), w: r3(box.w), h: r3(box.h) })
    if (o.source) {
      text(slide, `图片来源：${asText(o.source, 'source')}`, { x: frame.x, y: frame.y + frame.h + 0.06, w: frame.w, h: 0.26 },
        { pt: 9, color: o.sourceColor || theme.muted })
    }
  }

  /** 正文页的抬头：左上角色块 + 小标签（kicker）、标题、一句导语（lead）。 */
  function header(slide, { title, kicker, lead }) {
    rect(slide, { x: SIDE, y: 0.42, w: 0.12, h: 0.12 }, theme.accent)
    text(slide, kicker, { x: SIDE + 0.24, y: 0.34, w: 7, h: 0.28 }, { maxPt: 11, minPt: 9, bold: true, color: theme.accent })
    text(slide, title, { x: SIDE, y: 0.66, w: W - 2 * SIDE, h: 0.66 }, { maxPt: 28, minPt: 20, bold: true, color: theme.primary })
    text(slide, lead, { x: SIDE, y: 1.36, w: W - 2 * SIDE, h: 0.4 }, { maxPt: 14, minPt: 11, color: theme.muted })
  }

  /** 深色页右侧的装饰圆环（没有配图时用），都在页面内。 */
  function decor(slide) {
    circle(slide, { x: 8.6, y: 0.9, w: 3.9, h: 3.9 }, theme.accentOnDark, { ring: true, width: 1.5 })
    circle(slide, { x: 9.9, y: 3.4, w: 2.6, h: 2.6 }, theme.onDarkMuted, { ring: true, width: 1, transparency: 40 })
  }

  /**
   * 一列要点：每条左侧一道强调色竖条，有 head 的写成「标题 + 正文」。
   * 各条字号统一；每条的高度按内容定（最多 maxEach）。o.center 为真时整列在 box 里上下居中，否则从顶部排下来。
   * 返回实际用掉的高度。
   */
  function pointsList(slide, items, box, o = {}) {
    const x = box.x + 0.26
    const w = box.w - 0.26
    const headed = items.some(item => item.head && item.text)
    const gap = items.length > 5 ? 0.14 : headed ? 0.36 : 0.24
    const room = Math.min(o.maxEach || 1.5, (box.h - gap * (items.length - 1)) / items.length)
    const headPt = fitGroup(items.map(item => item.head), w, 0.42, o.headMax || 20, 13)
    const headH = headed ? textHeight('字', w, headPt) + 0.06 : 0
    const bodies = items.map(item => (item.head && item.text ? item.text : item.head || item.text))
    const bodyPt = fitGroup(bodies, w, room - headH, o.bodyMax || 16, 10)
    const each = clamp(headH + groupHeight(bodies, w, bodyPt) + 0.04, 0.42, room)
    const used = items.length * each + gap * (items.length - 1)
    const top = o.center ? box.y + Math.max(0, (box.h - used) / 2) : box.y
    items.forEach((item, i) => {
      const y = top + i * (each + gap)
      rect(slide, { x: box.x, y: y + 0.04, w: 0.06, h: each - 0.08 }, theme.accent)
      if (item.head && item.text) {
        text(slide, item.head, { x, y, w, h: headH }, { pt: headPt, bold: true, color: theme.primary })
        text(slide, item.text, { x, y: y + headH, w, h: each - headH }, { pt: bodyPt })
      } else {
        text(slide, bodies[i], { x, y, w, h: each }, { pt: bodyPt, valign: 'middle', bold: Boolean(item.head) })
      }
    })
    return used
  }

  /** 正文区里一块高 h 的内容，上下居中时的起点。 */
  const middle = h => area.y + Math.max(0, (area.h - h) / 2)

  /**
   * 一组上下相接的文字（标题、副标题……）先量后画：每段在 maxH 内定字号，按实际高度往下排，
   * 上一段再长也不会压到下一段。parts 每项 { value, maxPt, minPt, maxH, gap, spacing, 其余同 text 的 o }。
   */
  function measureStack(parts, w) {
    const laid = parts.filter(p => asText(p.value, '文字').trim()).map(p => {
      const s = String(p.value)
      const spacing = p.spacing || SPACING
      const pt = fitPt(s, w, p.maxH, p.maxPt, p.minPt, spacing)
      return { ...p, s, spacing, pt, h: textHeight(s, w, pt, spacing) }
    })
    const total = laid.reduce((sum, p, i) => sum + p.h + (i < laid.length - 1 ? p.gap ?? 0.2 : 0), 0)
    return { laid, total }
  }

  function drawStack(slide, x, w, top, laid) {
    let y = top
    for (const p of laid) {
      text(slide, p.s, { x, y, w, h: p.h }, { ...p, pt: p.pt })
      y += p.h + (p.gap ?? 0.2)
    }
  }

  /** 演讲备注。 */
  function addNotes(slide, notes) {
    if (notes) slide.addNotes(asText(notes, 'notes'))
  }

  const deck = {
    pptx,
    theme,
    themes: Object.keys(THEMES),

    /** 封面：左侧标题、副标题、落款；有 image 时右侧放相框图，没有就画装饰圆环。 */
    cover({ title, subtitle, kicker, meta, image, source, notes } = {}) {
      const slide = newSlide({ dark: true, numbered: false })
      const textW = image ? 6.2 : 7.4
      const { laid, total } = measureStack([
        { value: title, maxPt: 40, minPt: 26, maxH: 2.1, spacing: 1.05, bold: true, color: theme.onDark, gap: 0.3 },
        { value: subtitle, maxPt: 18, minPt: 12, maxH: 1.0, color: theme.onDarkMuted }
      ], textW)
      const top = clamp(3.4 - total / 2, 1.9, 6.0 - total)
      rect(slide, { x: 0.8, y: top + 0.04, w: 0.08, h: Math.max(0.6, total - 0.08) }, theme.accentOnDark)
      text(slide, kicker, { x: 1.1, y: top - 0.5, w: textW, h: 0.32 }, { maxPt: 13, minPt: 10, bold: true, color: theme.accentOnDark })
      drawStack(slide, 1.1, textW, top, laid)
      text(slide, meta, { x: 1.1, y: 6.2, w: textW, h: 0.4 }, { maxPt: 12, minPt: 10, color: theme.onDarkMuted })
      if (image) picture(slide, image, { x: 7.7, y: 1.0, w: 5.0, h: 5.2 }, { frameColor: theme.primary, source, sourceColor: theme.onDarkMuted })
      else decor(slide)
      addNotes(slide, notes)
      return slide
    },

    /** 目录：2～8 项，每项可以是文字或 { head, text }。 */
    agenda({ title = '目录', kicker, items, notes } = {}) {
      const rows = needList(items, 'agenda 的 items', 2, 8).map(asPoint)
      const slide = newSlide()
      header(slide, { title, kicker })
      const top = 1.6
      const rowH = Math.min(0.82, (CONTENT_BOTTOM - top) / rows.length)
      rows.forEach((row, i) => {
        const y = top + i * rowH
        rect(slide, { x: SIDE, y: y + 0.1, w: 0.62, h: rowH - 0.2 }, theme.primary, { round: true })
        text(slide, String(i + 1).padStart(2, '0'), { x: SIDE, y: y + 0.1, w: 0.62, h: rowH - 0.2 },
          { pt: 15, bold: true, color: theme.onDark, align: 'center', valign: 'middle' })
        text(slide, row.head || row.text, { x: SIDE + 0.85, y: y + 0.1, w: 4.4, h: rowH - 0.2 },
          { maxPt: 18, minPt: 12, bold: true, valign: 'middle' })
        if (row.head && row.text) {
          text(slide, row.text, { x: SIDE + 5.45, y: y + 0.1, w: W - 2 * SIDE - 5.45, h: rowH - 0.2 },
            { maxPt: 13, minPt: 10, color: theme.muted, valign: 'middle' })
        }
        if (i < rows.length - 1) rect(slide, { x: SIDE + 0.85, y: y + rowH - 0.01, w: W - 2 * SIDE - 0.85, h: 0.01 }, theme.line)
      })
      addNotes(slide, notes)
      return slide
    },

    /** 章节页：大号编号（no）、章节标题、一句说明；可配右侧相框图。 */
    section({ no, title, subtitle, image, source, notes } = {}) {
      const slide = newSlide({ dark: true, numbered: false })
      const textW = image ? 6.2 : 7.4
      text(slide, no, { x: 0.8, y: 1.2, w: 4, h: 1.45 }, { pt: 80, bold: true, color: theme.accentOnDark, spacing: 1.0 })
      rect(slide, { x: 0.85, y: 2.9, w: 0.9, h: 0.06 }, theme.accent2)
      drawStack(slide, 0.8, textW, 3.2, measureStack([
        { value: title, maxPt: 36, minPt: 24, maxH: 1.45, spacing: 1.05, bold: true, color: theme.onDark, gap: 0.25 },
        { value: subtitle, maxPt: 16, minPt: 12, maxH: 1.5, color: theme.onDarkMuted }
      ], textW).laid)
      if (image) picture(slide, image, { x: 7.7, y: 1.0, w: 5.0, h: 5.2 }, { frameColor: theme.primary, source, sourceColor: theme.onDarkMuted })
      else decor(slide)
      addNotes(slide, notes)
      return slide
    },

    /** 要点页：1～8 条要点（文字或 { head, text }）；有 image 时左要点、右相框图。 */
    bullets({ title, kicker, lead, points, image, source, notes } = {}) {
      const items = needList(points, 'bullets 的 points', 1, 8).map(asPoint)
      const slide = newSlide()
      header(slide, { title, kicker, lead })
      const textW = image ? 6.9 : area.w
      pointsList(slide, items, { x: area.x, y: area.y, w: textW, h: area.h }, { center: true })
      if (image) {
        picture(slide, image, { x: SIDE + 7.25, y: area.y, w: area.w - 7.25, h: area.h - 0.4 }, { frameColor: theme.card, source })
      }
      addNotes(slide, notes)
      return slide
    },

    /** 卡片组：2～6 张卡片（{ head, text, badge }），自动排成一行或两行。badge 默认是序号。 */
    cards({ title, kicker, lead, cards, notes } = {}) {
      const items = needList(cards, 'cards 的 cards', 2, 6)
      const slide = newSlide()
      header(slide, { title, kicker, lead })
      const cols = items.length <= 3 ? items.length : items.length === 4 ? 2 : 3
      const rows = Math.ceil(items.length / cols)
      const gap = 0.28
      const cw = (area.w - gap * (cols - 1)) / cols
      const inner = cw - 0.5
      const maxCh = (area.h - gap * (rows - 1)) / rows
      const points = items.map(asPoint)
      const badges = items.map((raw, i) => (raw && typeof raw === 'object' && raw.badge !== undefined ? asText(raw.badge, 'badge') : String(i + 1).padStart(2, '0')))
      // 同一组卡片的序号、小标题、正文各用同一个字号；卡片高度按最长的那张定，整组在正文区上下居中
      const badgePt = fitGroup(badges, inner, 0.5, 26, 16, 1.0)
      const headPt = fitGroup(points.map(p => p.head), inner, 0.64, 20, 13)
      const headH = Math.max(0.36, groupHeight(points.map(p => p.head), inner, headPt))
      const bodyY = 0.92 + headH + 0.16
      const bodyPt = fitGroup(points.map(p => p.text), inner, maxCh - bodyY - 0.22, 16, 10)
      const ch = clamp(bodyY + groupHeight(points.map(p => p.text), inner, bodyPt) + 0.3, Math.min(2.4, maxCh), maxCh)
      const top = middle(ch * rows + gap * (rows - 1))
      points.forEach((item, i) => {
        const x = area.x + (i % cols) * (cw + gap)
        const y = top + Math.floor(i / cols) * (ch + gap)
        rect(slide, { x, y, w: cw, h: ch }, theme.card, { round: true, line: theme.line })
        rect(slide, { x: x + 0.25, y: y + 0.22, w: 0.5, h: 0.05 }, theme.accent)
        text(slide, badges[i], { x: x + 0.25, y: y + 0.36, w: inner, h: 0.5 }, { pt: badgePt, bold: true, color: theme.accent, spacing: 1.0 })
        text(slide, item.head, { x: x + 0.25, y: y + 0.92, w: inner, h: headH }, { pt: headPt, bold: true, color: theme.primary })
        text(slide, item.text, { x: x + 0.25, y: y + bodyY, w: inner, h: ch - bodyY - 0.2 }, { pt: bodyPt })
      })
      addNotes(slide, notes)
      return slide
    },

    /** 大数字：2～4 个指标（{ value, label, note }）；可在下方再配 points 要点。 */
    stats({ title, kicker, lead, stats, points, notes } = {}) {
      const items = needList(stats, 'stats 的 stats', 2, 4)
      const extra = points ? needList(points, 'stats 的 points', 1, 4).map(asPoint) : []
      const slide = newSlide()
      header(slide, { title, kicker, lead })
      const gap = 0.3
      const tw = (area.w - gap * (items.length - 1)) / items.length
      const inner = tw - 0.5
      items.forEach(item => {
        if (!item || typeof item !== 'object') throw new Error('stats 每一项要写成 { value, label, note }')
      })
      const values = items.map(item => asText(item.value, 'value'))
      const labels = items.map(item => asText(item.label, 'label'))
      const remarks = items.map(item => asText(item.note, 'note'))
      const valuePt = fitGroup(values, inner, 0.9, 44, 22, 1.0)
      const labelPt = fitGroup(labels, inner, 0.42, 18, 11)
      const maxTh = extra.length ? 2.3 : 3.4
      const notePt = fitGroup(remarks, inner, maxTh - 1.95, 14, 9)
      const th = clamp(1.78 + groupHeight(remarks, inner, notePt) + 0.3, extra.length ? 1.9 : 2.3, maxTh)
      const top = extra.length ? area.y : middle(th)
      items.forEach((item, i) => {
        const x = area.x + i * (tw + gap)
        const color = i % 2 ? theme.accent2 : theme.accent
        rect(slide, { x, y: top, w: tw, h: th }, theme.card, { round: true, line: theme.line })
        rect(slide, { x, y: top, w: tw, h: 0.07 }, color)
        text(slide, values[i], { x: x + 0.25, y: top + 0.32, w: inner, h: 0.9 }, { pt: valuePt, bold: true, color, spacing: 1.0 })
        text(slide, labels[i], { x: x + 0.25, y: top + 1.3, w: inner, h: 0.42 }, { pt: labelPt, bold: true })
        text(slide, remarks[i], { x: x + 0.25, y: top + 1.78, w: inner, h: th - 1.93 }, { pt: notePt, color: theme.muted })
      })
      if (extra.length) pointsList(slide, extra, { x: area.x, y: top + th + 0.35, w: area.w, h: area.h - th - 0.35 }, { maxEach: 0.95 })
      addNotes(slide, notes)
      return slide
    },

    /** 图表：type 为 bar / line / pie / doughnut；categories 是横轴，series 是 [{ name, values }]。可配右侧 points。 */
    chart({ title, kicker, lead, type = 'bar', categories, series, note, points, notes } = {}) {
      const labels = needList(categories, 'chart 的 categories', 1, 24).map(c => asText(c, 'categories 的一项'))
      const data = needList(series, 'chart 的 series', 1, 6).map(s => {
        const values = needList(s && s.values, `chart 的 series「${s && s.name}」的 values`, labels.length, labels.length).map(Number)
        if (values.some(v => !Number.isFinite(v))) throw new Error(`series「${s.name}」里有不是数字的值：${JSON.stringify(s.values)}`)
        return { name: asText(s.name, 'series 的 name'), labels, values }
      })
      const kinds = { bar: pptx.ChartType.bar, line: pptx.ChartType.line, pie: pptx.ChartType.pie, doughnut: pptx.ChartType.doughnut }
      if (!kinds[type]) throw new Error(`chart 的 type 只能是 bar / line / pie / doughnut，现在是 ${type}`)
      const extra = points ? needList(points, 'chart 的 points', 1, 5).map(asPoint) : []
      const slide = newSlide()
      header(slide, { title, kicker, lead })
      const cw = extra.length ? 7.4 : area.w
      const ch = area.h - (note ? 0.4 : 0)
      const round = type === 'pie' || type === 'doughnut'
      // 数据标签按数据本身的小数位显示（最多两位）：默认格式会把 1.78 标成 2（2026-10-20 实测）
      const decimals = Math.min(2, Math.max(0, ...data.flatMap(s => s.values).map(v => (String(v).split('.')[1] || '').length)))
      // 只有一个系列的柱状图、折线图用一种颜色：给多种颜色时 pptxgenjs 会每根柱子换一种色，浅色那根几乎看不见
      const palette = [theme.accent, theme.accent2, theme.primary, theme.muted, theme.line, theme.dark]
      slide.addChart(kinds[type], data, {
        x: area.x, y: area.y, w: cw, h: ch,
        chartColors: round || data.length > 1 ? palette : [theme.accent],
        barDir: 'col', barGapWidthPct: 60,
        // 图例总是显示：单位常写在系列名里（如「老年人口（亿人）」），藏掉图例单位就没了
        showLegend: true, legendPos: 'b', legendFontFace: FONT, legendFontSize: 11,
        // 饼图、环形图标的是百分比，沿用 pptxgenjs 默认的百分比格式
        ...(round ? {} : { dataLabelFormatCode: decimals ? `#,##0.${'0'.repeat(decimals)}` : '#,##0' }),
        showValue: !round, showPercent: round, dataLabelFontFace: FONT, dataLabelFontSize: 10, dataLabelColor: theme.text,
        catAxisLabelFontFace: FONT, catAxisLabelFontSize: 11, catAxisLabelColor: theme.muted,
        valAxisLabelFontFace: FONT, valAxisLabelFontSize: 10, valAxisLabelColor: theme.muted,
        valGridLine: { color: theme.line, size: 0.5 }, lineSize: 2.5, lineDataSymbolSize: 7
      })
      text(slide, note, { x: area.x, y: area.y + ch + 0.08, w: cw, h: 0.3 }, { pt: 9, color: theme.muted })
      if (extra.length) pointsList(slide, extra, { x: area.x + cw + 0.35, y: area.y, w: area.w - cw - 0.35, h: area.h }, { center: true })
      addNotes(slide, notes)
      return slide
    },

    /** 表格：header 是表头（2～8 列），rows 是行（1～12 行，每行列数和表头一样）。 */
    table({ title, kicker, lead, header: head, rows, note, notes } = {}) {
      const cols = needList(head, 'table 的 header', 2, 8).map(h => asText(h, 'header 的一项'))
      const body = needList(rows, 'table 的 rows', 1, 12).map(r => needList(r, 'table 的一行', cols.length, cols.length).map(c => asText(c, '单元格')))
      const slide = newSlide()
      header(slide, { title, kicker, lead })
      const pt = body.length <= 6 ? 13 : body.length <= 9 ? 11 : 10
      const rowH = Math.min(0.55, (area.h - (note ? 0.4 : 0)) / (body.length + 1))
      const cell = (value, o) => ({ text: value, options: o })
      slide.addTable([
        cols.map(c => cell(c, { bold: true, color: theme.onDark, fill: { color: theme.primary } })),
        ...body.map((r, i) => r.map(c => cell(c, { color: theme.text, fill: { color: i % 2 ? theme.light : theme.card } })))
      ], {
        x: area.x, y: area.y, w: area.w, rowH, fontFace: FONT, fontSize: pt, valign: 'middle', margin: 0.08,
        border: { type: 'solid', color: theme.line, pt: 0.5 }, autoPage: false
      })
      text(slide, note, { x: area.x, y: area.y + rowH * (body.length + 1) + 0.1, w: area.w, h: 0.3 }, { pt: 9, color: theme.muted })
      addNotes(slide, notes)
      return slide
    },

    /** 时间线：2～6 个节点（{ time, head, text }），横向排开。 */
    timeline({ title, kicker, lead, steps, notes } = {}) {
      const items = needList(steps, 'timeline 的 steps', 2, 6)
      const slide = newSlide()
      header(slide, { title, kicker, lead })
      items.forEach(raw => {
        if (!raw || typeof raw !== 'object') throw new Error('timeline 每一步要写成 { time, head, text }')
      })
      const colW = area.w / items.length
      const inner = colW - 0.3
      const times = items.map(raw => asText(raw.time, 'time'))
      const heads = items.map(raw => asText(raw.head, 'head'))
      const texts = items.map(raw => asText(raw.text, 'text'))
      const timePt = fitGroup(times, inner, 0.6, 24, 13, 1.0)
      const headPt = fitGroup(heads, inner, 0.5, 18, 12)
      const textPt = fitGroup(texts, inner, area.h - 1.95, 15, 10)
      const textH = groupHeight(texts, inner, textPt)
      const lineY = middle(1.95 + textH) + 1.0
      rect(slide, { x: area.x + 0.2, y: lineY, w: area.w - 0.4, h: 0.04 }, theme.line)
      items.forEach((raw, i) => {
        const left = area.x + colW * i + 0.15
        const cx = left + inner / 2
        circle(slide, { x: cx - 0.14, y: lineY - 0.12, w: 0.28, h: 0.28 }, i % 2 ? theme.accent2 : theme.accent)
        text(slide, times[i], { x: left, y: lineY - 0.85, w: inner, h: 0.6 }, { pt: timePt, bold: true, color: theme.primary, align: 'center', valign: 'bottom', spacing: 1.0 })
        text(slide, heads[i], { x: left, y: lineY + 0.38, w: inner, h: 0.5 }, { pt: headPt, bold: true, align: 'center' })
        text(slide, texts[i], { x: left, y: lineY + 0.95, w: inner, h: Math.max(textH, area.y + area.h - lineY - 0.95) }, { pt: textPt, color: theme.muted, align: 'center' })
      })
      addNotes(slide, notes)
      return slide
    },

    /** 流程：2～6 步（{ head, text }），上方箭头色块写步骤名，下方写说明。 */
    process({ title, kicker, lead, steps, notes } = {}) {
      const items = needList(steps, 'process 的 steps', 2, 6).map(asPoint)
      const slide = newSlide()
      header(slide, { title, kicker, lead })
      const gap = 0.08
      const colW = (area.w - gap * (items.length - 1)) / items.length
      const heads = items.map((item, i) => item.head || `第 ${i + 1} 步`)
      const texts = items.map(item => item.text)
      const headPt = fitGroup(heads, colW - 0.76, 0.66, 18, 11)
      const bodyPt = fitGroup(texts, colW - 0.5, area.h - 1.55, 16, 10)
      const cardH = clamp(groupHeight(texts, colW - 0.5, bodyPt) + 0.45, 1.5, area.h - 1.15)
      const top = middle(1.15 + cardH)
      items.forEach((item, i) => {
        const x = area.x + i * (colW + gap)
        slide.addShape(i === 0 ? 'homePlate' : 'chevron', {
          x: r3(x), y: r3(top), w: r3(colW), h: 0.9, fill: { color: i % 2 ? theme.accent : theme.primary }
        })
        text(slide, heads[i], { x: x + 0.38, y: top + 0.12, w: colW - 0.76, h: 0.66 },
          { pt: headPt, bold: true, color: theme.onDark, align: 'center', valign: 'middle' })
        rect(slide, { x: x + 0.05, y: top + 1.15, w: colW - 0.1, h: cardH }, theme.card, { round: true, line: theme.line })
        text(slide, item.text, { x: x + 0.25, y: top + 1.35, w: colW - 0.5, h: cardH - 0.4 }, { pt: bodyPt })
      })
      addNotes(slide, notes)
      return slide
    },

    /** 对比：2～4 栏（{ head, points: [文字…] }），每栏一个表头色带加要点。 */
    compare({ title, kicker, lead, columns, notes } = {}) {
      const items = needList(columns, 'compare 的 columns', 2, 4)
      const slide = newSlide()
      header(slide, { title, kicker, lead })
      const gap = 0.3
      const cw = (area.w - gap * (items.length - 1)) / items.length
      const heads = items.map(col => {
        if (!col || typeof col !== 'object') throw new Error('compare 每一栏要写成 { head, points }')
        return asText(col.head, 'head')
      })
      const bodies = items.map((col, i) => needList(col.points, `compare 第 ${i + 1} 栏的 points`, 1, 8)
        .map(p => {
          const item = asPoint(p)
          return `• ${item.head ? `${item.head}：${item.text}` : item.text}`
        })
        .join('\n'))
      const headPt = fitGroup(heads, cw - 0.4, 0.5, 20, 12)
      const bodyPt = fitGroup(bodies, cw - 0.6, area.h - 1.15, 18, 10, 1.4)
      const colH = clamp(0.95 + groupHeight(bodies, cw - 0.6, bodyPt, 1.4) + 0.3, 2.6, area.h)
      const top = middle(colH)
      items.forEach((col, i) => {
        const x = area.x + i * (cw + gap)
        rect(slide, { x, y: top, w: cw, h: colH }, theme.card, { round: true, line: theme.line })
        rect(slide, { x, y: top, w: cw, h: 0.7 }, i % 2 ? theme.accent : theme.primary)
        text(slide, heads[i], { x: x + 0.2, y: top + 0.1, w: cw - 0.4, h: 0.5 },
          { pt: headPt, bold: true, color: theme.onDark, align: 'center', valign: 'middle' })
        text(slide, bodies[i], { x: x + 0.3, y: top + 0.95, w: cw - 0.6, h: colH - 1.15 }, { pt: bodyPt, spacing: 1.4 })
      })
      addNotes(slide, notes)
      return slide
    },

    /** 四象限：quadrants 正好 4 项（{ head, text }，顺序左上、右上、左下、右下）；xLabel / yLabel 是坐标轴说明。 */
    matrix({ title, kicker, lead, quadrants, xLabel, yLabel, notes } = {}) {
      const items = needList(quadrants, 'matrix 的 quadrants', 4, 4).map(asPoint)
      const slide = newSlide()
      header(slide, { title, kicker, lead })
      const gx = area.x + 0.1
      const gy = area.y + 0.35
      const gap = 0.16
      const qw = (area.w - 0.1 - gap) / 2
      const qh = (area.h - 0.35 - 0.35 - gap) / 2
      const headPt = fitGroup(items.map(item => item.head), qw - 0.6, 0.48, 20, 12)
      const textPt = fitGroup(items.map(item => item.text), qw - 0.6, qh - 0.95, 16, 10)
      text(slide, yLabel ? `↑ ${asText(yLabel, 'yLabel')}` : '', { x: gx, y: area.y, w: 5, h: 0.3 }, { pt: 11, bold: true, color: theme.muted })
      items.forEach((item, i) => {
        const x = gx + (i % 2) * (qw + gap)
        const y = gy + Math.floor(i / 2) * (qh + gap)
        const strong = i === 1
        rect(slide, { x, y, w: qw, h: qh }, strong ? theme.primary : theme.card, { round: true, line: strong ? undefined : theme.line })
        text(slide, item.head, { x: x + 0.3, y: y + 0.2, w: qw - 0.6, h: 0.48 }, { pt: headPt, bold: true, color: strong ? theme.onDark : theme.primary })
        text(slide, item.text, { x: x + 0.3, y: y + 0.75, w: qw - 0.6, h: qh - 0.95 }, { pt: textPt, color: strong ? theme.onDarkMuted : theme.text })
      })
      text(slide, xLabel ? `${asText(xLabel, 'xLabel')} →` : '', { x: area.x + area.w - 5, y: gy + 2 * qh + gap + 0.05, w: 5, h: 0.3 },
        { pt: 11, bold: true, color: theme.muted, align: 'right' })
      addNotes(slide, notes)
      return slide
    },

    /** 图文页：左侧大图（按原比例），右侧 1～5 条要点；source 是图片来源。 */
    imageText({ title, kicker, lead, image, source, points, notes } = {}) {
      const items = needList(points, 'imageText 的 points', 1, 5).map(asPoint)
      const slide = newSlide()
      header(slide, { title, kicker, lead })
      picture(slide, image, { x: area.x, y: area.y, w: 7.0, h: area.h - 0.4 }, { frameColor: theme.card, source })
      pointsList(slide, items, { x: area.x + 7.35, y: area.y, w: area.w - 7.35, h: area.h }, { center: true })
      addNotes(slide, notes)
      return slide
    },

    /** 引言页：一句话居中，可署名。 */
    quote({ text: words, author, notes } = {}) {
      const slide = newSlide()
      text(slide, '“', { x: 1.2, y: 0.8, w: 1.5, h: 1.7 }, { pt: 96, bold: true, color: theme.accent, spacing: 1.0 })
      text(slide, words, { x: 1.8, y: 2.2, w: W - 3.6, h: 2.6 }, { maxPt: 30, minPt: 18, bold: true, color: theme.primary, align: 'center', valign: 'middle' })
      text(slide, author ? `—— ${asText(author, 'author')}` : '', { x: 1.8, y: 5.0, w: W - 3.6, h: 0.45 }, { maxPt: 15, minPt: 12, color: theme.muted, align: 'center' })
      addNotes(slide, notes)
      return slide
    },

    /** 结尾页：标题（默认「谢谢」）、一句话，可列 1～4 条结论。 */
    closing({ title = '谢谢', subtitle, points, notes } = {}) {
      const slide = newSlide({ dark: true, numbered: false })
      const extra = points ? needList(points, 'closing 的 points', 1, 4).map(asPoint) : []
      const { laid, total } = measureStack([
        { value: title, maxPt: 44, minPt: 28, maxH: 1.5, spacing: 1.05, bold: true, color: theme.onDark, gap: 0.25 },
        { value: subtitle, maxPt: 18, minPt: 12, maxH: 0.9, color: theme.onDarkMuted }
      ], 7.4)
      const lines = extra.map(item => (item.head ? `${item.head}：${item.text}` : item.text))
      const linePt = fitGroup(lines, 7.2, 0.75, 16, 11)
      const listH = extra.length ? 0.5 + extra.length * 0.85 : 0
      const top = clamp(3.75 - (total + listH) / 2, 0.8, 6.8 - total - listH)
      drawStack(slide, 0.8, 7.4, top, laid)
      lines.forEach((line, i) => {
        const y = top + total + 0.5 + i * 0.85
        rect(slide, { x: 0.8, y: y + 0.08, w: 0.06, h: 0.6 }, theme.accentOnDark)
        text(slide, line, { x: 1.05, y, w: 7.2, h: 0.75 }, { pt: linePt, color: theme.onDark, valign: 'middle' })
      })
      decor(slide)
      addNotes(slide, notes)
      return slide
    },

    /**
     * 自定义页：版式都不合适时用。先画好抬头，draw 拿到 { slide, pptx, theme, area, text, picture, rect, circle }，
     * 只在 area（正文区）里画；text / picture 和版式函数里一样自动定字号、按原比例放图。
     */
    custom({ title, kicker, lead, notes } = {}, draw) {
      const slide = newSlide()
      header(slide, { title, kicker, lead })
      draw({
        slide, pptx, theme, area: { ...area },
        text: (value, box, o) => text(slide, value, box, o),
        picture: (file, box, o) => picture(slide, file, box, o),
        rect: (box, color, o) => rect(slide, box, color, o),
        circle: (box, color, o) => circle(slide, box, color, o)
      })
      addNotes(slide, notes)
      return slide
    },

    /** 保存：给正文页印页脚（PPT 标题 · 第几页 / 共几页，放在左下角），写出 .pptx，返回路径。 */
    async save(file) {
      const total = String(pages.length).padStart(2, '0')
      pages.forEach(({ slide, dark, numbered }, i) => {
        if (!numbered) return
        const no = `${String(i + 1).padStart(2, '0')} / ${total}`
        text(slide, footer ? `${footer}  ·  ${no}` : no, { x: SIDE, y: 7.05, w: 7.5, h: 0.24 }, { pt: 9, color: dark ? theme.onDarkMuted : theme.muted })
      })
      await pptx.writeFile({ fileName: asText(file, 'file') })
      return file
    }
  }
  return deck
}

module.exports = { createDeck, THEMES, fitPt, containBox, imageSize }
