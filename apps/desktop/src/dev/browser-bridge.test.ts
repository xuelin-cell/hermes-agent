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
    const tabs = [fakeTab(), fakeTab()]
    const open = vi.spyOn(window, 'open').mockImplementation(() => tabs.shift() as unknown as Window)

    await expect(window.hermesDesktop.openExternal('https://example.com/a')).resolves.toBe(true)
    await window.hermesDesktop.openPreviewInBrowser?.('https://example.com/b')
    // Blank first, handle dropped, then navigated: no window.opener for the page.
    expect(open.mock.calls).toEqual([
      ['', '_blank'],
      ['', '_blank']
    ])
    expect(open.mock.results.map(result => (result.value as FakeTab).location.href)).toEqual([
      'https://example.com/a',
      'https://example.com/b'
    ])
    expect(open.mock.results.every(result => (result.value as FakeTab).opener === null)).toBe(true)

    await window.hermesDesktop.openExternal('http://localhost:3000/')
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
    await window.hermesDesktop.openPreviewInBrowser?.('http://127.0.0.1:5173/app')
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2))
    expect(open).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ kind: 'warning' })
    expect(String(notify.mock.calls[0]?.[0]?.message)).toContain('localhost:3000')
    expect(String(notify.mock.calls[1]?.[0]?.message)).toContain('127.0.0.1:5173')
  })

  it('offers a button when the browser blocks a page the agent opened', async () => {
    const notify = vi.fn()

    vi.doMock('@/store/notifications', () => ({ notify }))
    await installFresh()
    const tab = fakeTab()
    const open = vi.spyOn(window, 'open').mockImplementationOnce(() => null)

    // No user gesture behind it (the agent's open_preview): the pop-up blocker says no.
    await expect(window.hermesDesktop.openExternal('https://example.com/report')).resolves.toBe(false)
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
    const offer = notify.mock.calls[0]?.[0]

    expect(offer).toMatchObject({ kind: 'info' })
    expect(String(offer.message)).toContain('example.com')

    // The user's click on the button is allowed to open it.
    open.mockImplementation(() => tab as unknown as Window)
    offer.action.onClick()
    expect(tab.location.href).toBe('https://example.com/report')
    expect(tab.opener).toBeNull()
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
})

describe('browser bridge: rename and the recycle bin', () => {
  interface Sent {
    body: Record<string, unknown>
    url: string
  }

  function instance(reply: (url: string, body: Record<string, unknown>) => Response): Sent[] {
    const sent: Sent[] = []

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>

      sent.push({ body, url: String(input) })

      return reply(String(input), body)
    }) as typeof fetch

    return sent
  }

  function previewStore(paths: string[]) {
    const closeRightRailTab = vi.fn()

    const $previewTabs = {
      get: () => [
        ...paths.map((path, i) => ({
          id: `file:${i}`,
          target: { kind: 'file', label: path, path, source: path, url: '' }
        })),
        { id: 'url:0', target: { kind: 'url', label: 'x', source: 'https://x', url: 'https://x' } }
      ]
    }

    vi.doMock('@/store/preview', () => ({ $previewTabs, closeRightRailTab }))

    return closeRightRailTab
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('@/store/notifications')
    vi.doUnmock('@/store/preview')
    vi.doUnmock('@/store/workspace-events')
  })

  it('moves a deleted file into the instance’s recycle bin and offers an undo', async () => {
    const notify = vi.fn()
    const notifyError = vi.fn()
    const notifyWorkspaceChanged = vi.fn()

    vi.doMock('@/store/notifications', () => ({ notify, notifyError }))
    vi.doMock('@/store/workspace-events', () => ({ notifyWorkspaceChanged }))

    // The tree uses the volume path; a tab opened from a tool result uses the workspace link.
    const closeRightRailTab = previewStore([
      '/opt/data/workspace/report/a.md',
      '/mnt/u/workspace/report',
      '/mnt/u/workspace/report-2/b.md'
    ])

    await installFresh()

    const sent = instance(url =>
      url.endsWith('/trash')
        ? jsonResponse({
            id: '1760000000000-0123abcd',
            name: 'report',
            ok: true,
            old_paths: ['/mnt/u/workspace/report', '/opt/data/workspace/report', '/mnt/u/workspace/report']
          })
        : jsonResponse({ ok: true, path: '/mnt/u/workspace/report' })
    )

    await expect(window.hermesDesktop.trashPath?.('file:///mnt/u/workspace/report')).resolves.toBe(true)
    expect(sent[0]).toEqual({
      body: { path: '/mnt/u/workspace/report' },
      url: '/__hermes_backend/__mt_user/files/trash'
    })
    // Both spellings of the folder close; a sibling that only shares the prefix stays.
    expect(closeRightRailTab.mock.calls).toEqual([['file:0'], ['file:1']])

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
    const toast = notify.mock.calls[0]?.[0]

    expect(toast).toMatchObject({ kind: 'success' })
    expect(String(toast.message)).toContain('report')

    toast.action.onClick()
    await vi.waitFor(() => expect(notifyWorkspaceChanged).toHaveBeenCalledTimes(1))
    expect(sent[1]).toEqual({
      body: { id: '1760000000000-0123abcd' },
      url: '/__hermes_backend/__mt_user/files/restore'
    })
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('treats a file that is already gone as deleted', async () => {
    previewStore([])
    await installFresh()
    instance(() => jsonResponse({ code: 'not_found', error: '文件不存在', ok: false }, 404))

    await expect(window.hermesDesktop.trashPath?.('/mnt/u/workspace/gone.txt')).resolves.toBe(true)
  })

  it('explains the instance’s refusals in the interface language', async () => {
    await installFresh()
    instance((url, body) =>
      String(body.path).includes('uploads')
        ? jsonResponse({ code: 'protected', error: '…', ok: false }, 403)
        : jsonResponse({ code: 'exists', error: '…', ok: false }, 409)
    )

    await expect(window.hermesDesktop.trashPath?.('/mnt/u/workspace/uploads')).rejects.toThrow(/attachments|附件/)
    await expect(window.hermesDesktop.renamePath?.('/mnt/u/workspace/a.md', 'b.md')).rejects.toThrow(
      /already exists|同名/
    )
  })

  it('asks for a reload when the instance predates the recycle bin', async () => {
    await installFresh()
    // An old forwarder hands the path to hermes, which has no such route.
    instance(() => jsonResponse({ detail: 'Not Found' }, 404))

    await expect(window.hermesDesktop.renamePath?.('/mnt/u/workspace/a.md', 'b.md')).rejects.toThrow(/Reload|刷新/)
  })

  it('renames through the instance and closes previews of the old path', async () => {
    const closeRightRailTab = previewStore(['/opt/data/workspace/a.md', '/opt/data/workspace/ab.md'])

    await installFresh()

    const sent = instance(() =>
      jsonResponse({
        ok: true,
        old_paths: ['/mnt/u/workspace/a.md', '/opt/data/workspace/a.md'],
        path: '/mnt/u/workspace/b.md'
      })
    )

    await expect(window.hermesDesktop.renamePath?.('/mnt/u/workspace/a.md', 'b.md')).resolves.toEqual({
      path: '/mnt/u/workspace/b.md'
    })
    expect(sent[0]).toEqual({
      body: { new_name: 'b.md', path: '/mnt/u/workspace/a.md' },
      url: '/__hermes_backend/__mt_user/files/rename'
    })
    expect(closeRightRailTab.mock.calls).toEqual([['file:0']])
  })
})

describe('browser bridge: the instance’s terminal', () => {
  class FakeSocket {
    static OPEN = 1
    static sockets: FakeSocket[] = []
    onclose: ((event: { code: number }) => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    readyState = 1
    sent: Record<string, unknown>[] = []

    constructor(public url: string) {
      FakeSocket.sockets.push(this)
    }

    send(data: string) {
      this.sent.push(JSON.parse(data) as Record<string, unknown>)
    }

    close(code = 1000) {
      this.readyState = 3
      this.onclose?.({ code })
    }

    receive(message: Record<string, unknown>) {
      this.onmessage?.({ data: JSON.stringify(message) })
    }
  }

  async function installProduction() {
    FakeSocket.sockets = []
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubEnv('VITE_HERMES_BROWSER_BUILD', '1')
    await installFresh()

    return window.hermesDesktop.terminal!
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    delete document.documentElement.dataset.hermesBrowser
  })

  it('is only offered by the production build, which has an instance behind it', async () => {
    await installFresh()
    expect(window.hermesDesktop.terminal).toBeUndefined()
  })

  it('runs a shell over one socket per tab', async () => {
    const terminal = await installProduction()
    const starting = terminal.start({ cols: 100, cwd: '/opt/data/workspace', rows: 30 })
    const socket = FakeSocket.sockets[0]!

    expect(socket.url).toBe(
      `ws://${window.location.host}/__hermes_backend/__mt_user/terminal?cols=100&cwd=%2Fopt%2Fdata%2Fworkspace&rows=30`
    )

    // The first prompt can arrive before the panel subscribes; it must not be lost.
    socket.receive({ cwd: '/opt/data/workspace', pid: 7, shell: 'bash', type: 'ready' })
    socket.receive({ data: '$ ', type: 'output' })
    const session = await starting

    expect(session).toMatchObject({ cwd: '/opt/data/workspace', shell: 'bash' })

    const output: string[] = []
    const exits: unknown[] = []

    terminal.onData(session.id, data => output.push(data))
    terminal.onExit(session.id, exit => exits.push(exit))
    expect(output).toEqual(['$ '])

    await expect(terminal.write(session.id, 'ls\r')).resolves.toBe(true)
    await expect(terminal.resize(session.id, { cols: 120, rows: 40 })).resolves.toBe(true)
    expect(socket.sent).toEqual([
      { data: 'ls\r', type: 'input' },
      { cols: 120, rows: 40, type: 'resize' }
    ])

    const cwd = terminal.cwd(session.id)
    const ask = socket.sent.at(-1)!

    expect(ask).toMatchObject({ type: 'cwd' })
    socket.receive({ cwd: '/tmp', seq: ask.seq, type: 'cwd' })
    await expect(cwd).resolves.toBe('/tmp')

    socket.receive({ data: 'a.txt\r\n', type: 'output' })
    socket.receive({ code: 0, signal: null, type: 'exit' })
    socket.close()
    expect(output).toEqual(['$ ', 'a.txt\r\n'])
    expect(exits).toEqual([{ code: 0, signal: null }])

    await expect(terminal.dispose(session.id)).resolves.toBe(true)
    await expect(terminal.write(session.id, 'x')).resolves.toBe(false)
  })

  it('keeps the tab and says so when the connection drops', async () => {
    const terminal = await installProduction()
    const starting = terminal.start()
    const socket = FakeSocket.sockets[0]!

    socket.receive({ cwd: '/opt/data/workspace', shell: 'bash', type: 'ready' })
    const session = await starting
    const output: string[] = []
    const exits: unknown[] = []

    terminal.onData(session.id, data => output.push(data))
    terminal.onExit(session.id, exit => exits.push(exit))
    socket.close(1006)

    expect(exits).toEqual([])
    expect(output.join('')).toMatch(/Disconnected|连接断了/)
  })

  it('fails the start when the instance cannot be reached', async () => {
    const terminal = await installProduction()
    const starting = terminal.start()

    FakeSocket.sockets[0]!.close(1006)
    await expect(starting).rejects.toThrow(/Could not reach|连不上/)
  })

  it('closes the socket when the panel disposes the tab', async () => {
    const terminal = await installProduction()
    const starting = terminal.start()
    const socket = FakeSocket.sockets[0]!

    socket.receive({ cwd: '/', shell: 'bash', type: 'ready' })
    const session = await starting
    const output: string[] = []

    terminal.onData(session.id, data => output.push(data))
    await terminal.dispose(session.id)
    expect(socket.readyState).toBe(3)
    expect(output).toEqual([]) // no "disconnected" notice for a tab the user closed
  })
})
