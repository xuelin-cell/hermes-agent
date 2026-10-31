import type { HermesApiRequest } from '@/global'
import type { MessagingOperationStatus, MessagingSetupRequest, MessagingSetupResult } from '../../electron/entry_local/messaging-contract'
import type { UniAgentGateReconnectResult } from '../../electron/entry_local/uniagentgate-contract'

/** Fixed, cookie-authenticated entry routes; no MaaS credential enters this bridge. */
export function browserMessaging(base: string) {
  let platform = 'uniagentgate'
  let generation = 0
  let revision = 0
  let pending = false
  let deadline = 0
  const listeners = new Set<(status: MessagingOperationStatus) => void>()
  let operation: MessagingOperationStatus = { phase: 'idle', revision: 0, profile: 'default' }
  const publish = (patch: Partial<MessagingOperationStatus>) => {
    operation = { ...operation, ...patch, revision: ++revision }
    for (const listener of listeners) listener(operation)
    return operation
  }
  const status = async (): Promise<MessagingOperationStatus> => {
    // A channel may reconnect indefinitely in the background. That is health,
    // not evidence that this browser is applying settings and must lock the page.
    if (!pending) return operation
    if (Date.now() >= deadline) {
      pending = false
      return publish({ phase: 'failed', error: 'connection_timeout' })
    }
    const requestedGeneration = generation
    try {
      const snapshot = await call<MessagingOperationStatus>('status', { platform })
      if (requestedGeneration !== generation) throw new Error('消息平台操作已切换')
      if (!pending) return operation
      if (['completed', 'idle', 'failed'].includes(snapshot.phase)) {
        pending = false
        return publish({ phase: snapshot.phase === 'failed' ? 'failed' : 'completed', saved: snapshot.saved,
          error: snapshot.phase === 'failed' ? snapshot.error || 'connection_timeout' : undefined })
      }
      if (Date.now() >= deadline) {
        pending = false
        return publish({ phase: 'failed', saved: snapshot.saved, error: 'connection_timeout' })
      }
      return operation
    } catch (error) {
      if (requestedGeneration === generation && Date.now() >= deadline) {
        pending = false
        return publish({ phase: 'failed', error: 'connection_timeout' })
      }
      throw error
    }
  }
  async function change<T>(action: string, body: Record<string, unknown>, target: string, kind?: MessagingOperationStatus['operation']): Promise<T> {
    platform = target
    const mine = ++generation
    pending = true
    deadline = Date.now() + 60_000
    publish({ phase: 'checking', operation: kind, platform: target === 'uniagentgate' ? undefined : target as MessagingOperationStatus['platform'],
      saved: false, error: undefined })
    try {
      const result = await call<T>(action, body)
      if (mine === generation) {
        const unbound = (result as { status?: string }).status === 'unbound'
        pending = !unbound
        publish({ phase: unbound ? 'idle' : 'checking', saved: !unbound })
      }
      return result
    } catch (error) {
      // The caller shows the request error. A lost response cannot prove whether a write committed.
      if (mine === generation) { pending = false; publish({ phase: 'idle', saved: undefined, error: undefined }) }
      throw error
    }
  }
  async function call<T>(operation: string, body?: unknown): Promise<T> {
    const response = await fetch(`${base}__entry/messaging/${operation}`, {
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {})
    })
    if (!response.ok) {
      if (response.status === 401) { throw new Error('登录已失效，请重新登录。') }
      throw new Error(await response.text() || '消息平台请求失败')
    }
    return response.json() as Promise<T>
  }
  return {
    messagingStatus: status,
    messagingSetup: (input: MessagingSetupRequest): Promise<MessagingSetupResult> => {
      if ((input.platform && !['dingtalk', 'wecom', 'weixin', 'feishu'].includes(input.platform)) || (input.profile && input.profile !== 'default')) {
        return Promise.reject(new Error('云端支持 5G、钉钉、飞书、微信和企业微信，其他平台尚未开放。'))
      }
      const target = input.platform ?? platform
      return change(input.operation, { ...input, platform: target }, target, input.operation)
    },
    reconnectUniAgentGate: (profile?: string) => {
      if (profile && profile !== 'default') { return Promise.reject(new Error('云端消息平台只支持默认实例。')) }
      return change<UniAgentGateReconnectResult>('reconnect', {}, 'uniagentgate')
    },
    onMessagingStatus(callback: (status: MessagingOperationStatus) => void) {
      let active = true
      listeners.add(callback)
      let refreshing = false
      const tick = () => {
        if (!document.hidden && !refreshing) {
          refreshing = true
          void status().then(snapshot => { if (active) {callback(snapshot)} }).catch(() => undefined).finally(() => { refreshing = false })
        }
      }
      tick()
      const timer = window.setInterval(tick, 6000)
      return () => { active = false; listeners.delete(callback); window.clearInterval(timer) }
    },
    request<T>(request: HermesApiRequest): Promise<T> | undefined {
      const [path, query] = request.path.split('?')
      if (path === '/api/cron/delivery-targets') return call<T>('targets').then(value => ({ targets: [{ id: 'local', name: '当前会话', home_target_set: true, home_env_var: null }, ...(value as { targets: unknown[] }).targets] }) as T)
      if (path.startsWith('/api/plugins/weixin-qr/')) {
        const profile = request.profile ?? new URLSearchParams(query).get('profile')
        if (profile && profile !== 'default') { return Promise.reject(new Error('云端消息平台只支持默认实例。')) }
        const method = request.method ?? 'GET'
        if (path === '/api/plugins/weixin-qr/login/start' && method === 'POST') {
          return call<T>('weixin-start', { platform: 'weixin' })
        }
        if (path === '/api/plugins/weixin-qr/unbind' && method === 'POST') {
          return call<T>('weixin-unbind', { platform: 'weixin' })
        }
        const match = path.match(/^\/api\/plugins\/weixin-qr\/login\/([^/]+)$/)
        if (match && method === 'GET') {
          return call<T>('weixin-status', { platform: 'weixin', session_id: decodeURIComponent(match[1]) })
        }
        return Promise.reject(new Error('不支持的微信操作。'))
      }
      if (request.profile && request.profile !== 'default' && (request.path.startsWith('/api/messaging/') || request.path === '/api/plugins/desktop-messaging/platforms')) {
        return Promise.reject(new Error('云端消息平台只支持默认实例。'))
      }
      if (request.path === '/api/plugins/desktop-messaging/platforms' && (!request.method || request.method === 'GET')) {
        return call<T>('platforms')
      }
      if (request.path.startsWith('/api/messaging/')) {
        if (path === '/api/messaging/weixin/groups' && ['GET', 'PUT'].includes(request.method ?? 'GET')) {
          if (request.profile && request.profile !== 'default') { return Promise.reject(new Error('云端消息平台只支持默认实例。')) }
          return call<T>('group-policy', { ...(request.body as object ?? {}), platform: 'weixin' })
        }
        if (request.path === '/api/messaging/platforms/uniagentgate' && request.method === 'PUT') {
          const body = request.body as { enabled?: boolean; env?: unknown }
          if (typeof body?.enabled === 'boolean' && !body.env) {
            return change(body.enabled ? 'enable' : 'disable', {}, 'uniagentgate').then(() => ({ ok: true, platform: 'uniagentgate' }) as T)
          }
        }
        return Promise.reject(new Error('该平台或消息类型尚未接通云端。'))
      }
      return undefined
    }
  }
}
