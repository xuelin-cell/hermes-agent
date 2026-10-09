import type {
  HermesApiRequest,
  HermesConnection,
  HermesReadDirResult,
  HermesReadFileTextResult,
  HermesSelectPathsOptions
} from '@/global'
import { browserShellCopy, isInstanceLocalUrl } from '@/lib/browser-shell'

const noopOff = () => () => undefined
const productionBrowserBuild = import.meta.env.VITE_HERMES_BROWSER_BUILD === '1'
const backendUrl = (import.meta.env.VITE_HERMES_BROWSER_BACKEND as string | undefined)?.replace(/\/$/, '')
const sessionToken = import.meta.env.VITE_HERMES_BROWSER_TOKEN as string | undefined

function browserBasePath(): string {
  const base = import.meta.env.BASE_URL || '/'

  return base.endsWith('/') ? base : `${base}/`
}

// Same-origin Vite proxy avoids weakening the backend's production CORS
// policy just for browser-based renderer development.
function apiPrefix(): string {
  return productionBrowserBuild ? `${browserBasePath()}__hermes_backend` : '/__hermes_backend'
}

function devBackendUrl(): string {
  return backendUrl || 'http://127.0.0.1:9120'
}

function connection(): HermesConnection {
  const token = productionBrowserBuild ? '' : sessionToken || 'hermes-browser-dev'

  const wsUrl = productionBrowserBuild
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${browserBasePath()}api/ws`
    : `${devBackendUrl().replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(token)}`

  return {
    authMode: 'token',
    // Production: REST lives behind the same-origin backend prefix. Development: the backend URL itself.
    baseUrl: productionBrowserBuild ? `${window.location.origin}${apiPrefix()}` : devBackendUrl(),
    connectionId: 'local',
    isFullscreen: false,
    // The renderer runs in a browser on one machine while the gateway runs on
    // another: every filesystem read, attachment upload and media preview has to
    // go through the gateway's HTTP API. That is exactly the desktop shell's
    // "remote gateway" mode, so the renderer takes its remote code paths.
    mode: 'remote',
    nativeOverlayWidth: 0,
    profile: 'default',
    remoteHost: window.location.host,
    remoteKind: 'url',
    source: 'local',
    token,
    wsUrl,
    logs: [],
    windowButtonPosition: null
  }
}

function authHeaders(): Headers {
  const headers = new Headers()

  if (!productionBrowserBuild) {
    headers.set('X-Hermes-Session-Token', connection().token)
  }

  return headers
}

function credentials(): RequestCredentials {
  return productionBrowserBuild ? 'same-origin' : 'omit'
}

async function api<T>({ body, method = 'GET', path, upload }: HermesApiRequest): Promise<T> {
  const headers = authHeaders()
  let requestBody: BodyInit | undefined

  if (upload) {
    const form = new FormData()
    form.append('file', new Blob([upload.bytes], { type: upload.contentType }), upload.filename)
    requestBody = form
  } else if (body !== undefined) {
    headers.set('Content-Type', 'application/json')
    requestBody = JSON.stringify(body)
  }

  const response = await fetch(`${apiPrefix()}${path}`, {
    body: requestBody,
    credentials: credentials(),
    headers,
    method
  })

  const text = await response.text()

  if (!response.ok) {
    throw new Error(`${response.status}: ${text || response.statusText}`)
  }

  return (text ? JSON.parse(text) : {}) as T
}

// ---------------------------------------------------------------------------
// Virtual local files.
//
// The renderer models every attachment as a PATH on the shell's disk: a dropped
// File becomes a path via `getPathForFile`, a pasted image is persisted with
// `saveImageBuffer`, and the bytes are read back later with `readFileDataUrl`
// (remote gateways upload them through `image.attach_bytes` / `file.attach`).
// A browser has no disk paths, so dropped/pasted/picked files are parked in
// memory under synthetic absolute paths and served back from there.
// ---------------------------------------------------------------------------

export const VIRTUAL_FILE_ROOT = '/__browser__/'
const VIRTUAL_FILE_LIMIT = 256
const virtualFiles = new Map<string, Blob>()
let virtualSeq = 0

function plainPath(path: string): string {
  if (!/^file:/i.test(path)) {
    return path
  }

  try {
    return decodeURIComponent(new URL(path).pathname)
  } catch {
    return path.replace(/^file:\/\//, '')
  }
}

function safeFileName(name: string): string {
  const base = (name || '').split(/[\\/]/).pop() || ''

  const cleaned = base
    .replace(/[^\p{L}\p{N}_.\- ]+/gu, '_')
    .trim()
    .slice(0, 120)

  return cleaned || 'file'
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp'
}

/** Raw bytes (pasted images, generated previews) arrive without a MIME type;
 * derive it from the extension so data URLs read back as `data:image/...` —
 * the renderer only thumbnails and inlines images with an image MIME. */
export function mimeForExtension(ext: string): string {
  const key = (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase()

  return MIME_BY_EXTENSION[key] || 'application/octet-stream'
}

function registerVirtualFile(blob: Blob, name: string): string {
  virtualSeq += 1
  const path = `${VIRTUAL_FILE_ROOT}${virtualSeq.toString(36)}/${safeFileName(name)}`

  virtualFiles.set(path, blob)

  while (virtualFiles.size > VIRTUAL_FILE_LIMIT) {
    const oldest = virtualFiles.keys().next().value

    if (oldest === undefined) {
      break
    }

    virtualFiles.delete(oldest)
  }

  return path
}

export function virtualFileFor(path: string): Blob | undefined {
  return virtualFiles.get(plainPath(path))
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'))
    reader.readAsDataURL(blob)
  })
}

function fsQuery(endpoint: string, path: string): string {
  return `/api/fs/${endpoint}?path=${encodeURIComponent(plainPath(path))}`
}

async function readFileDataUrl(path: string): Promise<string> {
  const local = virtualFileFor(path)

  if (local) {
    return blobToDataUrl(local)
  }

  const result = await api<string | { dataUrl?: string }>({ path: fsQuery('read-data-url', path) })

  return typeof result === 'string' ? result : result.dataUrl || ''
}

async function readDir(path: string): Promise<HermesReadDirResult> {
  try {
    return await api<HermesReadDirResult>({ path: fsQuery('list', path) })
  } catch (error) {
    return { entries: [], error: error instanceof Error ? error.message : String(error) }
  }
}

function readFileText(path: string): Promise<HermesReadFileTextResult> {
  return api<HermesReadFileTextResult>({ path: fsQuery('read-text', path) })
}

function selectPaths(options?: HermesSelectPathsOptions): Promise<string[]> {
  // A browser cannot hand out directory paths; in remote mode the renderer
  // routes directory picks through its own gateway-backed picker instead.
  if (options?.directories || typeof document === 'undefined') {
    return Promise.resolve([])
  }

  return new Promise(resolve => {
    const input = document.createElement('input')
    const extensions = (options?.filters ?? []).flatMap(filter => filter.extensions).filter(Boolean)
    let settled = false

    const finish = (paths: string[]) => {
      if (settled) {
        return
      }

      settled = true
      input.remove()
      resolve(paths)
    }

    input.type = 'file'
    input.multiple = options?.multiple ?? true
    input.style.display = 'none'

    if (extensions.length) {
      input.accept = extensions.map(ext => `.${ext.replace(/^\./, '')}`).join(',')
    }

    input.addEventListener('change', () => {
      finish(Array.from(input.files ?? []).map(file => registerVirtualFile(file, file.name)))
    })
    input.addEventListener('cancel', () => finish([]))
    document.body.appendChild(input)
    input.click()
  })
}

async function saveClipboardImage(): Promise<string> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard

  // Reading the clipboard needs a secure context and permission. The paste
  // event path (`saveImageBuffer`) keeps working without either.
  if (!clipboard || typeof clipboard.read !== 'function') {
    return ''
  }

  try {
    for (const item of await clipboard.read()) {
      const type = item.types.find(candidate => candidate.startsWith('image/'))

      if (type) {
        const blob = await item.getType(type)

        return registerVirtualFile(blob, `clipboard-${Date.now()}.${type.split('/')[1] || 'png'}`)
      }
    }
  } catch {
    // No permission / nothing readable: same as an empty clipboard.
  }

  return ''
}

async function saveGatewayFile(payload: {
  connectionId?: null | string
  path: string
  profile?: null | string
  suggestedName?: string
}): Promise<{ canceled?: boolean; path?: string; saved: boolean }> {
  const target = plainPath(payload.path)
  const response = await fetchGatewayFile(target)
  const name = payload.suggestedName || target.split('/').pop() || 'download'

  triggerBrowserDownload(await response.blob(), name)

  return { path: name, saved: true }
}

async function fetchGatewayFile(path: string): Promise<Response> {
  const response = await fetch(`${apiPrefix()}${fsQuery('download', path)}`, {
    credentials: credentials(),
    headers: authHeaders()
  })

  if (!response.ok) {
    throw new Error(`${response.status}: ${(await response.text()) || response.statusText}`)
  }

  return response
}

function triggerBrowserDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = name
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const EXTENSION_BY_IMAGE_MIME: Record<string, string> = {
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp'
}

/** Name for a saved image. Gateway images reach the renderer as `data:` URLs,
 * whose "path" is the base64 payload — never use that as a filename. */
export function imageDownloadName(src: string, mime: string): string {
  const ext = EXTENSION_BY_IMAGE_MIME[mime.split(';')[0].trim().toLowerCase()] || '.png'

  if (!/^data:/i.test(src)) {
    try {
      const last = new URL(src, window.location.href).pathname.split('/').filter(Boolean).pop()

      if (last) {
        return /\.[a-z0-9]{2,5}$/i.test(last) ? decodeURIComponent(last) : `${decodeURIComponent(last)}${ext}`
      }
    } catch {
      // fall through to the timestamped name
    }
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')

  return `image-${stamp}${ext}`
}

/** Image "Save" (hover button, lightbox): a browser download. Resolves false so
 * the caller does not toast the raw source string as the "saved file" name;
 * the browser's own download bar is the confirmation. */
async function saveImageFromUrl(src: string): Promise<boolean> {
  const response = await fetch(src, { credentials: credentials() })

  if (!response.ok) {
    throw new Error(`Could not fetch image: ${response.status}`)
  }

  const blob = await response.blob()

  triggerBrowserDownload(blob, imageDownloadName(src, blob.type))

  return false
}

// ---------------------------------------------------------------------------
// Opening things in a browser tab.
//
// The desktop shell hands web pages and previewed files to the OS browser. Here
// the browser IS the shell: a web page opens in a new tab, and a previewed file
// (staged in memory by `saveImageBuffer`, or living on the gateway) opens in a
// new tab as a blob.
// ---------------------------------------------------------------------------

/** A web page in a new tab — except an address on the agent's own machine
 * (see `isInstanceLocalUrl`), which is reported instead of opened. */
function openWebPage(url: string): boolean {
  if (isInstanceLocalUrl(url)) {
    const host = new URL(url).host

    void import('@/store/notifications').then(({ notify }) =>
      notify({ kind: 'warning', message: browserShellCopy().instanceLocalUrl(host) })
    )

    return false
  }

  window.open(url, '_blank', 'noopener,noreferrer')

  return true
}

const PREVIEW_TAB_MAX_BYTES = 64 * 1024 * 1024
// Blob URLs behind open preview tabs. Kept so a reload of such a tab works;
// past the limit the oldest are released (that tab then just can't reload).
const PREVIEW_TAB_URL_LIMIT = 20
const previewTabUrls: string[] = []

// Opened in an isolated frame: HTML, and SVG (it can carry script).
const ISOLATED_PREVIEW_TYPES: Record<string, string> = {
  '.htm': 'text/html',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.xhtml': 'text/html'
}

// Opened as they are: the browser's own image and PDF viewers.
const DIRECT_PREVIEW_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

function rememberPreviewUrl(url: string): string {
  previewTabUrls.push(url)

  while (previewTabUrls.length > PREVIEW_TAB_URL_LIMIT) {
    URL.revokeObjectURL(previewTabUrls.shift()!)
  }

  return url
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)
}

/** Agent-written HTML must not run as this app: a document opened straight from
 * a blob shares the app's origin and could call the gateway with the user's
 * session. It is framed instead, in an iframe sandboxed WITHOUT
 * `allow-same-origin` — its scripts run, in an opaque origin with no access to
 * the app, its storage or its cookies. */
export function isolatedPreviewPage(contentUrl: string, title: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;width:100%;height:100%;border:0}</style>',
    '</head><body>',
    `<iframe sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox" src="${escapeHtml(contentUrl)}"></iframe>`,
    '</body></html>'
  ].join('')
}

async function looksBinary(blob: Blob): Promise<boolean> {
  return new Uint8Array(await blob.slice(0, 4096).arrayBuffer()).includes(0)
}

/** The tab's address for a previewed file. The type comes from the extension —
 * never from the bytes or the server — so nothing becomes a live page except
 * through the isolated frame; other text shows as plain text. */
async function previewTabUrl(path: string): Promise<null | string> {
  const staged = virtualFileFor(path)
  let source = staged

  if (!source) {
    const response = await fetchGatewayFile(path)

    if (Number(response.headers.get('content-length') || 0) > PREVIEW_TAB_MAX_BYTES) {
      throw new Error(browserShellCopy().previewTooLarge)
    }

    source = await response.blob()
  }

  const ext = (path.match(/\.[^./\\]+$/)?.[0] || '').toLowerCase()
  const name = path.split('/').pop() || 'file'
  const isolated = ISOLATED_PREVIEW_TYPES[ext]

  if (isolated) {
    const content = rememberPreviewUrl(URL.createObjectURL(new Blob([source], { type: isolated })))
    // Staged copies carry a generated name (`pasted-<time>.html`).
    const title = staged ? browserShellCopy().previewTitle : name
    const page = new Blob([isolatedPreviewPage(content, title)], { type: 'text/html' })

    return rememberPreviewUrl(URL.createObjectURL(page))
  }

  const direct = DIRECT_PREVIEW_TYPES[ext]

  if (!direct && (await looksBinary(source))) {
    // Nothing a tab can show: hand the file over as a download.
    triggerBrowserDownload(source, name)

    return null
  }

  return rememberPreviewUrl(URL.createObjectURL(new Blob([source], { type: direct || 'text/plain;charset=utf-8' })))
}

async function openPreviewInBrowser(url: string): Promise<void> {
  if (/^https?:/i.test(url)) {
    openWebPage(url)

    return
  }

  // Open the tab now, while this still counts as part of the user's click:
  // reading the file from the gateway can outlast the browser's gesture window.
  const tab = window.open('', '_blank')

  if (!tab) {
    throw new Error(browserShellCopy().popupBlocked)
  }

  tab.opener = null

  try {
    const address = await previewTabUrl(plainPath(url))

    if (address) {
      tab.location.href = address
    } else {
      tab.close()
    }
  } catch (error) {
    tab.close()

    throw error
  }
}

/** Delete on the gateway — permanently: the desktop shell moves local files to
 * the OS trash, but the instance has no trash yet. The instance confines this
 * to the workspace: the sandbox image sets `HERMES_DASHBOARD_FILES_ROOT` to it
 * (tests/hermes_mt/test_hermes_contract.py pins that behaviour). */
async function trashPath(path: string): Promise<boolean> {
  try {
    await api({ body: { path: plainPath(path), recursive: true }, method: 'DELETE', path: '/api/files' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (message.startsWith('404:')) {
      // Already gone: the same end state.
      return true
    }

    if (message.startsWith('403:')) {
      throw new Error(browserShellCopy().deleteOutsideWorkspace)
    }

    throw error
  }

  return true
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)

      return true
    }
  } catch {
    // Fall through to the legacy path (plain http pages have no async clipboard).
  }

  if (typeof document === 'undefined') {
    return false
  }

  const area = document.createElement('textarea')

  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()

  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}

async function readClipboard(): Promise<string> {
  try {
    return (await navigator.clipboard?.readText?.()) ?? ''
  } catch {
    return ''
  }
}

/** RFC 4122 v4 UUID from `crypto.getRandomValues`, which (unlike `randomUUID`)
 * is available on plain-http pages. */
export function randomUUIDFallback(): `${string}-${string}-${string}-${string}-${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(16))

  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Browsers expose `crypto.randomUUID` only in secure contexts (https or
 * localhost). The browser build is served over plain http inside the intranet,
 * where the renderer's `crypto.randomUUID()` calls (composer attachment ids,
 * among others) would throw and silently drop pasted or picked images. */
export function ensureRandomUUID(): void {
  const cryptoObj = globalThis.crypto as (Crypto & { randomUUID?: unknown }) | undefined

  if (!cryptoObj || typeof cryptoObj.randomUUID === 'function' || typeof cryptoObj.getRandomValues !== 'function') {
    return
  }

  Object.defineProperty(cryptoObj, 'randomUUID', { configurable: true, value: randomUUIDFallback, writable: true })
}

/** Install enough of Electron's typed bridge for the real renderer to run in a
 * normal browser. Window/OS integrations degrade to no-ops; filesystem calls
 * are served from an in-memory store (files the user dropped, pasted or picked)
 * or forwarded to the gateway's `/api/fs/*` endpoints; gateway REST and
 * WebSocket traffic remains real. */
export function installBrowserDevelopmentBridge(): boolean {
  if ((!import.meta.env.DEV && !productionBrowserBuild) || typeof window === 'undefined' || window.hermesDesktop) {
    return false
  }

  ensureRandomUUID()

  const conn = connection()
  const asyncOk = async () => ({ ok: true })

  const bridge = {
    api,
    claimAmbientCue: async () => true,
    connections: {
      list: async () => ({
        version: 1,
        primary: 'local',
        secureTokenStorage: false,
        connections: [{ id: 'local', kind: 'local', label: 'This device', tokenSet: false, tokenPreview: null }]
      }),
      onChanged: noopOff,
      setLastUsed: asyncOk
    },
    getAgentRoster: async () => ({ agents: [] }),
    getBootProgress: async () => ({
      error: null,
      fakeMode: false,
      message: 'Browser development mode',
      phase: 'ready',
      progress: 1,
      retryable: false,
      running: false,
      timestamp: Date.now()
    }),
    getBootstrapState: async () => ({
      active: false,
      manifest: null,
      stages: {},
      error: null,
      log: [],
      startedAt: null,
      completedAt: null,
      setupChoice: null,
      unsupportedPlatform: null
    }),
    getConnection: async () => conn,
    getConnectionFor: async () => conn,
    getGatewayWsUrl: async () => ({ ok: true, wsUrl: conn.wsUrl }),
    getGatewayWsUrlFor: async () => ({ ok: true, wsUrl: conn.wsUrl }),
    getOnBattery: async () => false,
    getPathForFile: (file: File) => registerVirtualFile(file, file.name),
    getProfileRoutes: async () => [],
    getRecentLogs: async () => ({ path: '', lines: [] }),
    notify: async () => false,
    onBackendExit: noopOff,
    onBatteryChanged: noopOff,
    onBootProgress: noopOff,
    onBootstrapEvent: noopOff,
    onBrowserPopoutClosed: noopOff,
    onClosePreviewRequested: noopOff,
    onConnectionApplied: noopOff,
    onContextMenuSpellcheck: noopOff,
    onDeepLink: noopOff,
    onFocusSession: noopOff,
    onFoundInPage: noopOff,
    onNotificationAction: noopOff,
    onNotificationActivate: noopOff,
    onOpenFindBarRequested: noopOff,
    onOpenFolderRequested: noopOff,
    onOpenUpdatesRequested: noopOff,
    onPowerResume: noopOff,
    onPreviewFileChanged: noopOff,
    onPreviewNav: noopOff,
    onWindowStateChanged: noopOff,
    openExternal: async (url: string) => openWebPage(url),
    openPreviewInBrowser,
    profile: {
      get: async () => ({ profile: 'default' }),
      remember: async () => ({ profile: 'default' }),
      set: async () => ({ profile: 'default' })
    },
    readClipboard,
    readDir,
    readFileDataUrl,
    readFileDataUrlForAttach: readFileDataUrl,
    readFileText,
    revalidateConnection: async () => ({ ok: true, rebuilt: false }),
    reportRendererError: (report: { boundary: string; message: string }) => {
      console.error(`[browser-renderer:${report.boundary}]`, report.message)
    },
    revealLogs: async () => ({ ok: false, path: '', error: 'Native log folders are unavailable in a browser.' }),
    saveClipboardImage,
    saveGatewayFile,
    saveImageFromUrl,
    saveImageBuffer: async (data: ArrayBuffer | Uint8Array, ext: string) => {
      const suffix = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : '.png'

      return registerVirtualFile(
        new Blob([data as BlobPart], { type: mimeForExtension(suffix) }),
        `pasted-${Date.now()}${suffix}`
      )
    },
    selectPaths,
    setActiveConnectionRoute: () => undefined,
    setActiveWork: () => undefined,
    setKeepAwake: asyncOk,
    setTranslucency: asyncOk,
    touchBackend: asyncOk,
    trashPath,
    translucencySupported: false,
    glassSupported: false,
    writeClipboard
  }

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: bridge })
  document.documentElement.dataset.hermesBrowser = productionBrowserBuild ? 'production' : 'development'

  return true
}

installBrowserDevelopmentBridge()
