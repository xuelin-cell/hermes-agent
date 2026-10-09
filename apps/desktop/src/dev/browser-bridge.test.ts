import { afterEach, describe, expect, it, vi } from 'vitest'

const originalBridge = window.hermesDesktop
const originalFetch = globalThis.fetch

afterEach(() => {
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: originalBridge })
  globalThis.fetch = originalFetch
  vi.resetModules()
})

async function installFresh() {
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: undefined })

  const mod = await import('./browser-bridge')

  mod.installBrowserDevelopmentBridge()

  return mod
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('browser development bridge', () => {
  it('provides safe browser fallbacks for renderer error logging', async () => {
    await installFresh()

    await expect(window.hermesDesktop.getRecentLogs()).resolves.toEqual({ path: '', lines: [] })
    await expect(window.hermesDesktop.revealLogs()).resolves.toMatchObject({ ok: false, path: '' })
    expect(window.hermesDesktop.reportRendererError).toBeTypeOf('function')
  })

  it('reports a remote connection so the renderer uploads attachments and reads files via the gateway', async () => {
    await installFresh()

    const conn = await window.hermesDesktop.getConnection()

    expect(conn.mode).toBe('remote')
    expect(conn.wsUrl).toMatch(/\/api\/ws/)
  })

  it('parks dropped and pasted files in memory and serves them back as data URLs', async () => {
    const { VIRTUAL_FILE_ROOT, virtualFileFor } = await installFresh()
    const bridge = window.hermesDesktop

    const dropped = new File([new TextEncoder().encode('hello')], 'notes.txt', { type: 'text/plain' })
    const droppedPath = bridge.getPathForFile(dropped)

    expect(droppedPath.startsWith(VIRTUAL_FILE_ROOT)).toBe(true)
    expect(droppedPath.endsWith('/notes.txt')).toBe(true)
    expect(virtualFileFor(droppedPath)).toBe(dropped)
    await expect(bridge.readFileDataUrl(droppedPath)).resolves.toBe('data:text/plain;base64,aGVsbG8=')
    // file:// spelling of the same virtual path resolves too (media helpers may hand it over that way)
    await expect(bridge.readFileDataUrl(`file://${droppedPath}`)).resolves.toBe('data:text/plain;base64,aGVsbG8=')

    const pastedPath = await bridge.saveImageBuffer(new Uint8Array([137, 80, 78, 71]), '.png')

    expect(pastedPath.startsWith(VIRTUAL_FILE_ROOT)).toBe(true)
    expect(pastedPath.endsWith('.png')).toBe(true)
    await expect(bridge.readFileDataUrl(pastedPath)).resolves.toMatch(/^data:.*;base64,iVBORw==$/)
    expect(await bridge.readFileDataUrlForAttach?.(pastedPath)).toMatch(/^data:/)
  })

  it('reads gateway-side files and directories through /api/fs', async () => {
    await installFresh()
    const calls: string[] = []

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)

      calls.push(url)

      if (url.includes('/api/fs/read-data-url')) {
        return jsonResponse({ dataUrl: 'data:image/png;base64,QUJD' })
      }

      if (url.includes('/api/fs/list') && !url.includes('nope')) {
        return jsonResponse({ entries: [{ name: 'chart.png', path: '/opt/data/workspace/chart.png', isDirectory: false }] })
      }

      return jsonResponse({ detail: 'not found' }, 404)
    }) as typeof fetch

    await expect(window.hermesDesktop.readFileDataUrl('/opt/data/workspace/chart.png')).resolves.toBe(
      'data:image/png;base64,QUJD'
    )
    expect(calls[0]).toBe('/__hermes_backend/api/fs/read-data-url?path=%2Fopt%2Fdata%2Fworkspace%2Fchart.png')

    const listing = await window.hermesDesktop.readDir('/opt/data/workspace')

    expect(listing.entries.map(entry => entry.name)).toEqual(['chart.png'])

    const missing = await window.hermesDesktop.readDir('/nope')

    expect(missing.entries).toEqual([])
    expect(missing.error).toContain('404')
  })

  it('downloads gateway files through the browser instead of a native save dialog', async () => {
    await installFresh()
    const clicks: string[] = []

    globalThis.fetch = vi.fn(async () => new Response(new Blob(['png-bytes']), { status: 200 })) as typeof fetch
    URL.createObjectURL = vi.fn(() => 'blob:fake')
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download)
    })

    const result = await window.hermesDesktop.saveGatewayFile?.({ path: 'file:///opt/data/workspace/chart.png' })

    expect(result).toEqual({ path: 'chart.png', saved: true })
    expect(clicks).toEqual(['chart.png'])
    expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]).toBe(
      '/__hermes_backend/api/fs/download?path=%2Fopt%2Fdata%2Fworkspace%2Fchart.png'
    )
  })

  it('picks files with a hidden file input and registers them as virtual paths', async () => {
    const { VIRTUAL_FILE_ROOT } = await installFresh()

    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      const picked = new File(['x'], 'pick.txt', { type: 'text/plain' })

      Object.defineProperty(this, 'files', { configurable: true, value: [picked] })
      this.dispatchEvent(new Event('change'))
    })

    const paths = await window.hermesDesktop.selectPaths({ filters: [{ name: 'Text', extensions: ['txt'] }] })

    expect(paths).toHaveLength(1)
    expect(paths[0].startsWith(VIRTUAL_FILE_ROOT) && paths[0].endsWith('/pick.txt')).toBe(true)
    await expect(window.hermesDesktop.selectPaths({ directories: true })).resolves.toEqual([])
    clickSpy.mockRestore()
  })
})
