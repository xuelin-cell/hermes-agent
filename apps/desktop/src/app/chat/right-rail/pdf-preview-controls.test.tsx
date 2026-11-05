import { describe, expect, it } from 'vitest'

import { currentSlide } from './pdf-preview-controls'

describe('which page the counter shows', () => {
  const pages = [
    { bottom: 316, top: 16 },
    { bottom: 632, top: 332 },
    { bottom: 948, top: 648 }
  ]

  it('is the page filling most of the view, or the last one at the end', () => {
    expect(currentSlide(pages, { bottom: 500, top: 0 }, false)).toBe(1)
    expect(currentSlide(pages, { bottom: 750, top: 250 }, false)).toBe(2)
    expect(currentSlide(pages, { bottom: 964, top: 464 }, false)).toBe(3)
    expect(currentSlide(pages, { bottom: 600, top: 400 }, true)).toBe(3)
    // Two pages fully in view: the first of them.
    expect(currentSlide(pages, { bottom: 2000, top: 0 }, false)).toBe(1)
    expect(currentSlide([], { bottom: 500, top: 0 }, false)).toBe(1)
  })
})
