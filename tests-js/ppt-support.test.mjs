import { createRequire } from 'node:module'
import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const { createHelpers, contain, estimateText } = require('../plugins/uniwork-kits/pptx_support/helpers.cjs')

test('contain preserves aspect ratio and centers both landscape and portrait assets', () => {
  const frame = { x: 1, y: 2, w: 5, h: 3 }
  for (const [w, h] of [[1600, 900], [900, 1600], [1000, 1000]]) {
    const rect = contain({ w, h }, frame)
    expect(rect.w / rect.h).toBeCloseTo(w / h)
    expect(rect.x + rect.w / 2).toBeCloseTo(frame.x + frame.w / 2)
    expect(rect.y + rect.h / 2).toBeCloseTo(frame.y + frame.h / 2)
    expect(rect.w).toBeLessThanOrEqual(frame.w)
    expect(rect.h).toBeLessThanOrEqual(frame.h)
  }
})

test('themes and free-form pages retain editable text without shrinking or rewriting content', () => {
  const calls = []
  const slide = { addText: (text, options) => calls.push({ text, options }), addShape: () => {} }
  const h = createHelpers({ ShapeType: { rect: 'rect' } }, { ink: '123456', fontFace: 'Test Font' })
  const original = '保留这个数字 194μg，以及本页的完整结论'
  h.text(slide, original, { x: 0.6, y: 1.7, w: 7, h: 2, fontSize: 20 })
  expect(calls[0].text).toBe(original)
  expect(calls[0].options.color).toBe('123456')
  expect(calls[0].options.fontSize).toBe(20)
  expect(calls[0].options.fit).toBeUndefined()
  expect(estimateText(original.repeat(20), { w: 2, h: 0.3, fontSize: 20 }).fits).toBe(false)
  expect(() => h.text(slide, original, { x: 1, y: 1, w: 5, h: 2, fontSize: 8 })).toThrow()
  h.layouts.cards(slide, { title: '另一个版式', items: [
    { heading: '一', body: '内容一' }, { heading: '二', body: '内容二' }
  ] })
  expect(calls.some(call => call.text === '内容二')).toBe(true)
})
