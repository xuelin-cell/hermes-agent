import type { HermesApiRequest, HermesConnection } from '@/global'
import { browserBackendError, fetchBrowserBackend } from './browser-backend-error'

const PREFIX = '/api/plugins/uniwork-kits'

/** Only plugin-owned profiles are resolved; one instance backend serves all of them. */
export function browserKits(base: string, primary: HermesConnection, mutate: <T>(request: HermesApiRequest) => Promise<T>) {
  async function resolve(profile: null | string = 'default'): Promise<HermesConnection> {
    const name = profile?.trim() || 'default'
    const response = await fetchBrowserBackend(`${base}__hermes_backend${PREFIX}/cloud/profile?name=${encodeURIComponent(name)}`)
    if (!response.ok) { throw await browserBackendError(response) }
    return { ...primary, profile: name, sharedPrimary: true, sharedRemote: true,
      wsUrl: `${primary.wsUrl}${primary.wsUrl.includes('?') ? '&' : '?'}kits=1` } as HermesConnection
  }
  return {
    cloudKits: true,
    getConnection: resolve,
    getConnectionFor: async (request: { profile?: null | string; connectionId?: null | string }) => {
      if (request.connectionId && request.connectionId !== 'local') { throw new Error('云端只支持当前账号的实例。') }
      return resolve(request.profile)
    },
    getGatewayWsUrl: async () => ({ ok: true as const, wsUrl: (await resolve()).wsUrl }),
    getGatewayWsUrlFor: async () => ({ ok: true as const, wsUrl: (await resolve()).wsUrl }),
    async request<T>(request: HermesApiRequest): Promise<T> {
      const method = request.method || 'GET'
      const [path] = request.path.split('?')
      const tail = path === '/api/profiles' ? '/cloud/profiles' : path.slice(PREFIX.length)
      const actions: Record<string, string> = {
        '/toggle': 'toggle', '/config': 'config', '/uninstall': 'uninstall',
        '/cloud/install': 'install', '/experts/sync': 'sync', '/experts/recent': 'recent'
      }
      if (method === 'POST' && actions[tail]) {
        const result = await mutate<T>({ path: `${PREFIX}/cloud/action`, method: 'POST', profile: 'default',
          body: { ...request.body as object, operation: actions[tail] } })
        return (tail === '/experts/sync' ? { changes: [] } : result) as T
      }
      let target = tail === '' || tail === '/' ? '/cloud/catalog' : tail === '/experts' ? '/cloud/experts' : tail
      if (/^\/experts\/[^/]+\/avatar$/.test(tail)) { target = '/cloud' + tail }
      if (tail === '/bundled') { target = '/cloud/bundled' }
      if (method !== 'GET' || !(target === '/cloud/profiles' || target === '/cloud/bundled' || target === '/cloud/catalog' || target === '/cloud/experts' || /^\/cloud\/experts\/[^/]+\/avatar$/.test(target))) {
        throw new Error('当前云端尚不支持此套件操作。')
      }
      target += '?profile=default'
      const response = await fetchBrowserBackend(`${base}__hermes_backend${PREFIX}${target}`)
      if (!response.ok) { throw await browserBackendError(response) }
      return response.json() as Promise<T>
    }
  }
}
