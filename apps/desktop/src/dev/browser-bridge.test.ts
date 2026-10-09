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
  it('supplies crypto.randomUUID on plain-http pages where browsers withhold it', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID')
    const protoDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), 'randomUUID')

    // Simulate a non-secure context: no randomUUID anywhere on the crypto object.
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined, writable: true })

    try {
      const { ensureRandomUUID, randomUUIDFallback } = await installFresh()

      expect(typeof globalThis.crypto.randomUUID).toBe('function')
      const id = globalThis.crypto.randomUUID()

      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(new Set(Array.from({ length: 50 }, () => randomUUIDFallback())).size).toBe(50)

      // Native implementations are left alone.
      const native = () => '00000000-0000-4000-8000-000000000000' as const

      Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: native, writable: true })
      ensureRandomUUID()
      expect(globalThis.crypto.randomUUID).toBe(native)
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor)
      } else {
        delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID
      }

      expect(typeof (protoDescriptor?.value ?? globalThis.crypto.randomUUID)).toBe('function')
    }
  })

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
    // Pasted bytes carry no MIME; it is derived from the extension so the
    // renderer treats the data URL as an image (thumbnail + inline bubble).
    await expect(bridge.readFileDataUrl(pastedPath)).resolves.toBe('data:image/png;base64,iVBORw==')
    expect(await bridge.readFileDataUrlForAttach?.(pastedPath)).toMatch(/^data:image\/png;/)
  })

  it('maps image extensions to MIME types and falls back to octet-stream', async () => {
    const { mimeForExtension } = await installFresh()

    expect(mimeForExtension('.PNG')).toBe('image/png')
    expect(mimeForExtension('jpg')).toBe('image/jpeg')
    expect(mimeForExtension('.html')).toBe('text/html')
    expect(mimeForExtension('.xyz')).toBe('application/octet-stream')
  })

  it('names saved images sensibly, never after a data: URL payload', async () => {
    const { imageDownloadName } = await installFresh()

    expect(imageDownloadName('data:image/png;base64,iVBORw0KGgo=', 'image/png')).toMatch(/^image-\d{8}-\d{6}\.png$/)
    expect(imageDownloadName('data:image/jpeg;base64,/9j/', 'image/jpeg')).toMatch(/\.jpg$/)
    expect(imageDownloadName('https://cdn.example/out/chart.png?x=1', 'image/png')).toBe('chart.png')
    expect(imageDownloadName('https://cdn.example/out/a1b2c3', 'image/webp')).toBe('a1b2c3.webp')
  })

  it('saves images through a browser download and does not claim a saved path', async () => {
    await installFresh()
    const names: string[] = []

    globalThis.fetch = vi.fn(
      async () => new Response(new Blob(['x'], { type: 'image/png' }), { status: 200 })
    ) as typeof fetch
    URL.createObjectURL = vi.fn(() => 'blob:fake')
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download)
    })

    await expect(window.hermesDesktop.saveImageFromUrl('data:image/png;base64,eA==')).resolves.toBe(false)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^image-\d{8}-\d{6}\.png$/)
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
        return jsonResponse({
          entries: [{ name: 'chart.png', path: '/opt/data/workspace/chart.png', isDirectory: false }]
        })
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

    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement
    ) {
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

describe('browser bridge: opening in a tab and deleting', () => {
  interface FakeTab {
    close: ReturnType<typeof vi.fn>
    location: { href: string }
    opener: unknown
  }

  function fakeTab(): FakeTab {
    return { close: vi.fn(), location: { href: '' }, opener: window }
  }

  function captureBlobs(): Blob[] {
    const blobs: Blob[] = []

    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob)

      return `blob:${blobs.length}`
    })
    URL.revokeObjectURL = vi.fn()

    return blobs
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('@/store/notifications')
  })

  it('marks the document so the renderer knows it runs in a browser', async () => {
    await installFresh()
    const { isBrowserShell } = await import('@/lib/browser-shell')

    expect(document.documentElement.dataset.hermesBrowser).toBe('development')
    expect(isBrowserShell()).toBe(true)
  })

  it('opens web pages in a new tab but reports the instance’s own addresses instead', async () => {
    const notify = vi.fn()

    vi.doMock('@/store/notifications', () => ({ notify }))
    await installFresh()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    await window.hermesDesktop.openExternal('https://example.com/a')
    await window.hermesDesktop.openPreviewInBrowser?.('https://example.com/b')
    expect(open.mock.calls).toEqual([
      ['https://example.com/a', '_blank', 'noopener,noreferrer'],
      ['https://example.com/b', '_blank', 'noopener,noreferrer']
    ])

    await window.hermesDesktop.openExternal('http://localhost:3000/')
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
    await window.hermesDesktop.openPreviewInBrowser?.('http://127.0.0.1:5173/app')
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2))
    expect(open).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ kind: 'warning' })
    expect(String(notify.mock.calls[0]?.[0]?.message)).toContain('localhost:3000')
    expect(String(notify.mock.calls[1]?.[0]?.message)).toContain('127.0.0.1:5173')
  })

  it('opens staged HTML in a new tab inside a sandboxed frame without the app’s origin', async () => {
    await installFresh()
    const tab = fakeTab()
    const open = vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window)
    const blobs = captureBlobs()

    const staged = await window.hermesDesktop.saveImageBuffer(new TextEncoder().encode('<script>1</script>'), '.html')

    await window.hermesDesktop.openPreviewInBrowser?.(`file://${staged}`)

    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(tab.opener).toBeNull()
    expect(tab.location.href).toBe('blob:2')
    expect(blobs[0]?.type).toBe('text/html')
    await expect(blobs[0]!.text()).resolves.toBe('<script>1</script>')

    const page = await blobs[1]!.text()

    expect(blobs[1]?.type).toBe('text/html')
    expect(page).toContain('<iframe sandbox="allow-scripts')
    expect(page).toContain('src="blob:1"')
    expect(page).not.toContain('allow-same-origin')
  })

  it('opens gateway files by extension: images as they are, other text as plain text', async () => {
    await installFresh()
    const tab = fakeTab()

    vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window)
    const blobs = captureBlobs()

    globalThis.fetch = vi.fn(async () => new Response('<b>not html</b>', { status: 200 })) as typeof fetch

    await window.hermesDesktop.openPreviewInBrowser?.('file:///mnt/u/workspace/chart.png')
    await window.hermesDesktop.openPreviewInBrowser?.('file:///mnt/u/workspace/notes.md')

    expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]).toBe(
      '/__hermes_backend/api/fs/download?path=%2Fmnt%2Fu%2Fworkspace%2Fchart.png'
    )
    expect(blobs.map(blob => blob.type)).toEqual(['image/png', 'text/plain;charset=utf-8'])
    expect(tab.location.href).toBe('blob:2')
  })

  it('closes the tab and reports the error when the gateway refuses', async () => {
    await installFresh()
    const tab = fakeTab()

    vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window)
    globalThis.fetch = vi.fn(async () => jsonResponse({ detail: 'Access denied' }, 403)) as typeof fetch

    await expect(window.hermesDesktop.openPreviewInBrowser?.('file:///opt/data/.env')).rejects.toThrow('403')
    expect(tab.close).toHaveBeenCalled()
  })

  it('says so when the browser blocks the new tab', async () => {
    await installFresh()
    vi.spyOn(window, 'open').mockImplementation(() => null)

    await expect(window.hermesDesktop.openPreviewInBrowser?.('file:///mnt/u/workspace/a.png')).rejects.toThrow(
      /pop-ups|弹出窗口/
    )
  })

  it('deletes through the gateway, permanently and recursively', async () => {
    await installFresh()
    const requests: { body: string; method: string; url: string }[] = []

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ body: String(init?.body), method: String(init?.method), url: String(input) })

      if (String(init?.body).includes('gone')) {
        return jsonResponse({ detail: 'Path not found' }, 404)
      }

      if (String(init?.body).includes('config.yaml')) {
        return jsonResponse({ detail: 'Path outside managed files root' }, 403)
      }

      return jsonResponse({ ok: true })
    }) as typeof fetch

    await expect(window.hermesDesktop.trashPath?.('file:///mnt/u/workspace/old%20dir')).resolves.toBe(true)
    expect(requests[0]).toEqual({
      body: JSON.stringify({ path: '/mnt/u/workspace/old dir', recursive: true }),
      method: 'DELETE',
      url: '/__hermes_backend/api/files'
    })

    // Already gone is the same end state; outside the workspace gets a plain explanation.
    await expect(window.hermesDesktop.trashPath?.('/mnt/u/workspace/gone.txt')).resolves.toBe(true)
    await expect(window.hermesDesktop.trashPath?.('/opt/data/config.yaml')).rejects.toThrow(/workspace|工作区/)
  })
})
