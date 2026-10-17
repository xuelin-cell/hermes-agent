import { describe, expect, it } from 'vitest'

import { absolutizeCssUrls, isOpaqueColor, stripActiveContent } from './rendered-pdf-export'

describe('absolutizeCssUrls', () => {
  it('resolves relative refs against the stylesheet base', () => {
    expect(absolutizeCssUrls("src: url('./fonts/a.woff2')", 'file:///app/dist/assets/index.css')).toBe(
      "src: url('file:///app/dist/assets/fonts/a.woff2')"
    )
  })

  it('leaves data, blob, http and fragment refs untouched', () => {
    const css =
      'a{background:url(data:image/png;base64,AA)} b{x:url(https://x.test/a.png)} c{y:url(#id)} d{z:url(blob:abc)}'

    expect(absolutizeCssUrls(css, 'file:///app/')).toBe(css)
  })
})

describe('isOpaqueColor', () => {
  it.each([
    ['rgb(255, 255, 255)', true],
    ['rgba(0, 0, 0, 1)', true],
    ['oklch(0.98 0 0)', true],
    ['oklch(0.2 0 0 / 100%)', true],
    ['transparent', false],
    ['rgba(0, 0, 0, 0)', false],
    ['rgba(20, 20, 20, 0.6)', false],
    ['oklch(0.2 0 0 / 0.5)', false],
    ['color(srgb 1 1 1 / 40%)', false]
  ])('%s → %s', (color, expected) => {
    expect(isOpaqueColor(color)).toBe(expected)
  })
})

describe('stripActiveContent', () => {
  it('removes scripts, embeds, event handlers and javascript: urls', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<p onclick="x()">t</p><script>bad()</script><iframe src="https://x.test"></iframe>' +
      '<a href="javascript:alert(1)">l</a><img src="data:image/png;base64,AA" onerror="y()">'

    stripActiveContent(root)

    expect(root.querySelector('script, iframe')).toBeNull()
    expect(root.querySelector('p')?.hasAttribute('onclick')).toBe(false)
    expect(root.querySelector('a')?.hasAttribute('href')).toBe(false)
    expect(root.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA')
    expect(root.querySelector('img')?.hasAttribute('onerror')).toBe(false)
  })
})
