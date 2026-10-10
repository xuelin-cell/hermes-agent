import { afterEach, describe, expect, it, vi } from 'vitest'

const originalBridge = window.hermesDesktop

afterEach(() => {
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: originalBridge })
  vi.resetModules()
})

describe('browser development bridge', () => {
  it('provides safe browser fallbacks for renderer error logging', async () => {
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: undefined })

    const { installBrowserDevelopmentBridge } = await import('./browser-bridge')

    installBrowserDevelopmentBridge()

    await expect(window.hermesDesktop.getRecentLogs()).resolves.toEqual({ path: '', lines: [] })
    await expect(window.hermesDesktop.revealLogs()).resolves.toMatchObject({ ok: false, path: '' })
    expect(window.hermesDesktop.reportRendererError).toBeTypeOf('function')
  })
})
