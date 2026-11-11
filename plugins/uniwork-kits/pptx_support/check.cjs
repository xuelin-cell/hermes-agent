'use strict'

// Run from the task's build directory, using that directory's existing pptxgenjs.
const path = require('node:path')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const { createHelpers, estimateText } = require('./helpers.cjs')

async function main() {
  const fromTask = createRequire(path.join(process.cwd(), 'package.json'))
  const PptxGenJS = fromTask('pptxgenjs')
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  const h = createHelpers(pptx, { accent: '356A4D', background: 'FAFCF8' })
  const slide = pptx.addSlide()
  h.layouts.cards(slide, { title: '公共函数小样', subtitle: '检查文字、图标和卡片接口，不作为用户成品',
    items: [{ heading: '文字接口', body: '颜色用 color，字号以磅为单位。' },
      { heading: '坐标接口', body: '各页共用稳定函数，构图仍可自由设计。' }] })
  h.addIcon(slide, 'check', { x: 11.9, y: 0.5, size: 0.4, color: '356A4D' })
  if (!estimateText('检查短句', { w: 3, h: 1, fontSize: 18 }).fits) throw new Error('Text fit check failed')
  // Private preflight bytes must not enter delivery, deck-bounce budgets or first-build metrics.
  const requested = path.resolve(process.argv[2] || '.tmp/ppt-helper-check.pptx.check')
  const fileName = requested.endsWith('.pptx') ? requested + '.check' : requested
  fs.mkdirSync(path.dirname(fileName), { recursive: true })
  fs.writeFileSync(fileName, await pptx.write({ outputType: 'nodebuffer' }))
  console.log(JSON.stringify({ status: 'built_needs_render_review', path: fileName }))
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
