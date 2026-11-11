'use strict'

// Low-level geometry is shared; content, theme and composition belong to the author.
const { addIcon } = require('../pptx_icons/icons.cjs')

function box(value) {
  const result = Object.fromEntries(['x', 'y', 'w', 'h'].map(key => [key, value[key]]))
  if (!Object.values(result).every(Number.isFinite) || result.w <= 0 || result.h <= 0) {
    throw new Error('Use finite x/y and positive w/h in inches')
  }
  return result
}

function estimateText(value, { w, fontSize = 16, lineSpacingMultiple = 1.15, h } = {}) {
  if (!(w > 0 && fontSize > 0 && lineSpacingMultiple >= 1)) throw new Error('Invalid text measurement')
  const text = Array.isArray(value) ? value.map(run => run.text ?? '').join('') : String(value)
  const capacity = w * 72 / fontSize
  const lines = text.split('\n').reduce((sum, line) => {
    const units = [...line].reduce((n, char) => n + (char.codePointAt(0) > 255 ? 1 : 0.55), 0)
    return sum + Math.max(1, Math.ceil(units / capacity))
  }, 0)
  const height = lines * fontSize * lineSpacingMultiple / 72 + 0.04
  return { lines, height, fits: h == null ? null : height <= h }
}

function contain(asset, frame) {
  const rect = box(frame)
  if (!(Number.isFinite(asset.w) && Number.isFinite(asset.h) && asset.w > 0 && asset.h > 0)) {
    throw new Error('Use the real pixel dimensions from the photo manifest')
  }
  const scale = Math.min(rect.w / asset.w, rect.h / asset.h)
  const w = asset.w * scale
  const h = asset.h * scale
  return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h }
}

function createHelpers(pptx, theme = {}) {
  const style = { fontFace: 'Microsoft YaHei', ink: '243746', background: 'FFFFFF',
    accent: '276A87', muted: '556575', card: 'F2F6F8', ...theme }

  function text(slide, value, options) {
    const { x, y, w, h } = box(options)
    const fontSize = options.fontSize ?? 16
    if (!Number.isFinite(fontSize) || fontSize < 12) throw new Error('Body text must be at least 12 pt; use caption() only for sources/footers')
    if (typeof value !== 'string' && !(Array.isArray(value) && value.every(run => typeof run?.text === 'string'))) {
      throw new Error('Text must be a string or an array of { text, options } runs')
    }
    if (Array.isArray(value) && value.some(run => (run.options?.fontSize ?? fontSize) < 12)) {
      throw new Error('Body text runs must also be at least 12 pt')
    }
    if (options.lineSpacing != null || options.fit === 'shrink' || options.autoFit) {
      throw new Error('Use lineSpacingMultiple; shorten text or enlarge its box instead of shrinking')
    }
    const { fill, ...rest } = options
    slide.addText(value, { ...rest, x, y, w, h, fontFace: options.fontFace ?? style.fontFace,
      fontSize, color: options.color ?? style.ink, margin: options.margin ?? 0, valign: options.valign ?? 'top',
      breakLine: false, lineSpacingMultiple: options.lineSpacingMultiple ?? 1.15,
      ...(fill ? { fill: typeof fill === 'string' ? { color: fill } : fill } : {}) })
  }

  function caption(slide, value, options) {
    const rect = box(options)
    slide.addText(String(value), { ...options, ...rect, fontFace: options.fontFace ?? style.fontFace,
      color: options.color ?? style.muted, fontSize: options.fontSize ?? 9, margin: 0 })
  }

  function card(slide, options) {
    const rect = box(options)
    const fill = options.fill ?? style.card
    slide.addShape(pptx.ShapeType.rect, { ...rect,
      fill: typeof fill === 'string' ? { color: fill } : fill,
      line: { color: options.lineColor ?? (typeof fill === 'string' ? fill : style.card), width: 0.5 } })
  }

  function image(slide, asset, frame) {
    const rect = contain(asset, frame)
    slide.addImage({ path: asset.path, ...rect })
    return rect
  }

  function header(slide, { title, subtitle, page, total }) {
    slide.background = { color: style.background }
    text(slide, title, { x: 0.6, y: 0.4, w: 12.1, h: 0.65, fontSize: 30, bold: true, color: style.accent })
    if (subtitle) text(slide, subtitle, { x: 0.6, y: 1.12, w: 12.1, h: 0.55, fontSize: 16, color: style.muted })
    if (page != null) caption(slide, total ? `${page} / ${total}` : page,
      { x: 11.7, y: 7.12, w: 1, h: 0.2, align: 'right' })
  }

  // Optional whole-page layouts. Free-form pages can use text/image/card directly.
  function imageText(slide, { title, subtitle, asset, heading, body, source, imageSide = 'left' }) {
    header(slide, { title, subtitle })
    const left = imageSide === 'left'
    const rect = image(slide, asset, { x: left ? 0.6 : 7.6, y: 2, w: 5.1, h: 4.4 })
    const tx = left ? 6.2 : 0.6
    text(slide, heading, { x: tx, y: 2.1, w: 6.3, h: 0.65, fontSize: 24, bold: true })
    text(slide, body, { x: tx, y: 3, w: 6.3, h: 3.2, fontSize: 18 })
    if (source) caption(slide, source, { x: rect.x, y: 6.55, w: rect.w, h: 0.35 })
  }

  function cards(slide, { title, subtitle, items }) {
    if (items.length < 2 || items.length > 4) throw new Error('Use 2–4 cards, or choose a different composition')
    header(slide, { title, subtitle })
    const gap = 0.25
    const w = (12.1 - gap * (items.length - 1)) / items.length
    items.forEach((item, index) => {
      const x = 0.6 + index * (w + gap)
      card(slide, { x, y: 2, w, h: 4.5, fill: item.fill })
      text(slide, item.heading, { x: x + 0.2, y: 2.3, w: w - 0.4, h: 0.85, fontSize: 22, bold: true })
      text(slide, item.body, { x: x + 0.2, y: 3.5, w: w - 0.4, h: 2.6, fontSize: 16 })
    })
  }

  return { text, caption, card, image, header, addIcon, estimateText, contain,
    layouts: { imageText, cards }, theme: style }
}

module.exports = { createHelpers, estimateText, contain }
