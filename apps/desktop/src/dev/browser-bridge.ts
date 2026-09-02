import type { HermesApiRequest, HermesConnection } from '@/global'

const noopOff = () => () => undefined
const productionBrowserBuild = import.meta.env.VITE_HERMES_BROWSER_BUILD === '1'
const backendUrl = (import.meta.env.VITE_HERMES_BROWSER_BACKEND as string | undefined)?.replace(/\/$/, '')
const sessionToken = import.meta.env.VITE_HERMES_BROWSER_TOKEN as string | undefined

function browserBasePath(): string {
  const base = import.meta.env.BASE_URL || '/'

  return base.endsWith('/') ? base : `${base}/`
}

function connection(): HermesConnection {
  const baseUrl = productionBrowserBuild ? window.location.origin : backendUrl || 'http://127.0.0.1:9120'
  const token = productionBrowserBuild ? '' : sessionToken || 'hermes-browser-dev'
  const wsUrl = productionBrowserBuild
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${browserBasePath()}api/ws`
    : `${baseUrl.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(token)}`

  return {
    authMode: 'token',
    baseUrl,
    connectionId: 'local',
    isFullscreen: false,
    mode: 'local',
    nativeOverlayWidth: 0,
    profile: 'default',
    source: 'local',
    token,
    wsUrl,
    logs: [],
    windowButtonPosition: null
  }
}

async function api<T>({ body, method = 'GET', path, upload }: HermesApiRequest): Promise<T> {
  const conn = connection()
  const headers = new Headers()

  if (!productionBrowserBuild) {
    headers.set('X-Hermes-Session-Token', conn.token)
  }
  let requestBody: BodyInit | undefined

  if (upload) {
    const form = new FormData()
    form.append('file', new Blob([upload.bytes], { type: upload.contentType }), upload.filename)
    requestBody = form
  } else if (body !== undefined) {
    headers.set('Content-Type', 'application/json')
    requestBody = JSON.stringify(body)
  }

  // Same-origin Vite proxy avoids weakening the backend's production CORS
  // policy just for browser-based renderer development.
  const apiPrefix = productionBrowserBuild ? `${browserBasePath()}__hermes_backend` : '/__hermes_backend'
  const response = await fetch(`${apiPrefix}${path}`, {
    body: requestBody,
    credentials: productionBrowserBuild ? 'same-origin' : 'omit',
    headers,
    method
  })
  const text = await response.text()

  if (!response.ok) {
    throw new Error(`${response.status}: ${text || response.statusText}`)
  }

  return (text ? JSON.parse(text) : {}) as T
}

/** Install enough of Electron's typed bridge for the real renderer to run in a
 * normal browser. Native window/filesystem integrations intentionally degrade
 * to no-ops; gateway REST and WebSocket traffic remains real. */
export function installBrowserDevelopmentBridge(): boolean {
  if ((!import.meta.env.DEV && !productionBrowserBuild) || typeof window === 'undefined' || window.hermesDesktop) {
    return false
  }

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
    openExternal: async (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer')
      return true
    },
    profile: {
      get: async () => ({ profile: 'default' }),
      remember: async () => ({ profile: 'default' }),
      set: async () => ({ profile: 'default' })
    },
    revalidateConnection: async () => ({ ok: true, rebuilt: false }),
    reportRendererError: (report: { boundary: string; message: string }) => {
      console.error(`[browser-renderer:${report.boundary}]`, report.message)
    },
    revealLogs: async () => ({ ok: false, path: '', error: 'Native log folders are unavailable in a browser.' }),
    setActiveConnectionRoute: () => undefined,
    setActiveWork: () => undefined,
    setKeepAwake: asyncOk,
    setTranslucency: asyncOk,
    touchBackend: asyncOk,
    translucencySupported: false,
    glassSupported: false
  }

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: bridge })
  document.documentElement.dataset.hermesBrowser = productionBrowserBuild ? 'production' : 'development'

  return true
}

installBrowserDevelopmentBridge()
