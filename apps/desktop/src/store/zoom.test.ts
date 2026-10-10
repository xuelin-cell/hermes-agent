import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const desktopWindow = window as unknown as { hermesDesktop?: unknown }

describe('browser zoom store', () => {
  beforeEach(() => {
    vi.resetModules()
    delete desktopWindow.hermesDesktop
    window.localStorage.clear()
    document.documentElement.style.zoom = ''
  })

  afterEach(() => {
    delete desktopWindow.hermesDesktop
    window.localStorage.clear()
    document.documentElement.style.zoom = ''
  })

  it('applies, reflects, and persists a selected zoom without the Electron bridge', async () => {
    const { $zoomPercent, setZoomPercent } = await import('./zoom')

    expect($zoomPercent.get()).toBe(90)
    expect(document.documentElement.style.zoom).toBe('90%')

    setZoomPercent(125)

    expect($zoomPercent.get()).toBe(125)
    expect(document.documentElement.style.zoom).toBe('125%')
    expect(window.localStorage.getItem('uniwork.browser.zoomPercent.v1')).toBe('125')
  })

  it('restores the persisted browser zoom when the page loads again', async () => {
    window.localStorage.setItem('uniwork.browser.zoomPercent.v1', '150')

    const { $zoomPercent } = await import('./zoom')

    expect($zoomPercent.get()).toBe(150)
    expect(document.documentElement.style.zoom).toBe('150%')
  })
})
