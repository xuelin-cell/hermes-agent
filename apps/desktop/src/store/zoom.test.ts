import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const initialHermesDesktop = desktopWindow.hermesDesktop
const retiredBrowserZoomKey = 'uniwork.browser.zoomPercent.v1'
const initialBrowserZoom = window.localStorage.getItem(retiredBrowserZoomKey)
const initialCssZoom = document.documentElement.style.zoom

type ZoomBridge = NonNullable<Window['hermesDesktop']['zoom']>
type ZoomPayload = Awaited<ReturnType<ZoomBridge['get']>>

/** 安装受控原生缩放桥接，验证主进程读取与变更事件。 */
function installZoomBridge(zoom: ZoomBridge): void {
  desktopWindow.hermesDesktop = { zoom } as unknown as Window['hermesDesktop']
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.style.zoom = initialCssZoom

  if (initialBrowserZoom === null) {
    window.localStorage.removeItem(retiredBrowserZoomKey)
  } else {
    window.localStorage.setItem(retiredBrowserZoomKey, initialBrowserZoom)
  }

  if (initialHermesDesktop) {
    desktopWindow.hermesDesktop = initialHermesDesktop
  } else {
    delete desktopWindow.hermesDesktop
  }
})

describe('zoom state sync', () => {
  it('uses the initial read when no newer change has arrived', async () => {
    const zoom: ZoomBridge = {
      get: vi.fn().mockResolvedValue({ level: 1, percent: 125 }),
      onChanged: vi.fn(() => vi.fn()),
      setPercent: vi.fn()
    }

    installZoomBridge(zoom)

    const { $zoomPercent } = await import('./zoom')

    expect($zoomPercent.get()).toBe(125)
  })

  it('sends settings through native zoom and waits for the authoritative change event', async () => {
    let emitChanged: ((payload: ZoomPayload) => void) | undefined

    const zoom: ZoomBridge = {
      get: vi.fn().mockResolvedValue({ level: 0, percent: 100 }),
      onChanged: vi.fn(callback => {
        emitChanged = callback

        return vi.fn()
      }),
      setPercent: vi.fn()
    }

    installZoomBridge(zoom)

    const { $zoomPercent, setZoomPercent } = await import('./zoom')

    setZoomPercent(125)

    expect(zoom.setPercent).toHaveBeenCalledExactlyOnceWith(125)
    expect($zoomPercent.get()).toBe(100)
    emitChanged?.({ level: 1, percent: 125 })
    expect($zoomPercent.get()).toBe(125)
    expect(document.documentElement.style.zoom).toBe(initialCssZoom)
  })

  it('does not read or write browser preferences or apply CSS zoom without the native bridge', async () => {
    delete desktopWindow.hermesDesktop
    window.localStorage.setItem(retiredBrowserZoomKey, '160')
    const read = vi.spyOn(Storage.prototype, 'getItem')
    const write = vi.spyOn(Storage.prototype, 'setItem')

    const { $zoomPercent, setZoomPercent } = await import('./zoom')
    setZoomPercent(125)

    expect($zoomPercent.get()).toBe(90)
    expect(document.documentElement.style.zoom).toBe(initialCssZoom)
    expect(read).not.toHaveBeenCalledWith(retiredBrowserZoomKey)
    expect(write).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(retiredBrowserZoomKey)).toBe('160')
  })

  it('does not let a stale initial read overwrite a newer zoom event', async () => {
    const callOrder: string[] = []
    let emitChanged: ((payload: ZoomPayload) => void) | undefined
    let resolveInitialRead: ((payload: ZoomPayload) => void) | undefined

    const initialRead = new Promise<ZoomPayload>(resolve => {
      resolveInitialRead = resolve
    })

    const zoom: ZoomBridge = {
      get: vi.fn(() => {
        callOrder.push('get')

        return initialRead
      }),
      onChanged: vi.fn(callback => {
        callOrder.push('subscribe')
        emitChanged = callback

        return vi.fn()
      }),
      setPercent: vi.fn()
    }

    installZoomBridge(zoom)

    const { $zoomPercent } = await import('./zoom')

    expect(callOrder).toEqual(['subscribe', 'get'])
    emitChanged?.({ level: 1, percent: 125 })
    resolveInitialRead?.({ level: 0, percent: 100 })
    await initialRead
    await Promise.resolve()

    expect($zoomPercent.get()).toBe(125)
  })
})
