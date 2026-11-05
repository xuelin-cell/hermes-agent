import { describe, expect, it } from 'vitest'

import { findInPageTakenByViewer } from './find-in-page-mt'

describe('findInPageTakenByViewer', () => {
  it('is true while the PDF viewer has focus, so ⌘F searches the PDF and not the chat', () => {
    const viewer = document.createElement('div')
    const pages = document.createElement('div')

    viewer.dataset.pdfViewer = ''
    pages.tabIndex = 0
    viewer.append(pages)
    document.body.append(viewer)

    expect(findInPageTakenByViewer()).toBe(false)

    pages.focus()
    expect(findInPageTakenByViewer()).toBe(true)

    pages.blur()
    expect(findInPageTakenByViewer()).toBe(false)

    viewer.remove()
  })
})
