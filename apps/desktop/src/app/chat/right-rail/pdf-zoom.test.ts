import { describe, expect, it } from 'vitest'

import { clampZoom, fitScale, MAX_ZOOM, MIN_ZOOM, stepZoom } from './pdf-zoom'

describe('PDF zoom', () => {
  it('steps like a browser, from wherever the zoom is', () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1, -1)).toBe(0.9)
    // A fitted zoom between two steps goes to the next one either way.
    expect(stepZoom(0.59, 1)).toBe(0.67)
    expect(stepZoom(0.59, -1)).toBe(0.5)
    // Rounding (pdf.js keeps two decimals) does not make a step stick.
    expect(stepZoom(1.099, 1)).toBe(1.25)
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM)
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM)
    expect([clampZoom(0.1), clampZoom(1.3), clampZoom(9)]).toEqual([MIN_ZOOM, 1.3, MAX_ZOOM])
  })

  it('fits a page to the pane, no wider than the page viewer shows one', () => {
    // A4 portrait (595 × 842 pt = 793 × 1123 px): the pane's width, at most 768px.
    expect(fitScale(793, 1123, 500)).toBeCloseTo(500 / 793)
    expect(fitScale(793, 1123, 1400)).toBeCloseTo(768 / 793)
    // A slide is allowed wider.
    expect(fitScale(1280, 720, 1400)).toBeCloseTo(1024 / 1280)
    // A hidden pane has no room to fit into.
    expect(fitScale(793, 1123, 0)).toBeNull()
    expect(fitScale(0, 0, 500)).toBeNull()
  })
})
