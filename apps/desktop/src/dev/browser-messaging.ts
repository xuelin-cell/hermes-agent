import type { HermesApiRequest } from '@/global'
import type { MessagingOperationStatus, MessagingSetupRequest, MessagingSetupResult } from '../../electron/entry_local/messaging-contract'
import type { UniAgentGateReconnectResult } from '../../electron/entry_local/uniagentgate-contract'

/** Fixed, cookie-authenticated entry routes; no MaaS credential enters this bridge. */
export function browserMessaging(base: string) {
  let platform = 'uniagentgate'
  let revision = 0
  const status = async () => {
    const requestedPlatform = platform
    const requestedRevision = revision
    const snapshot = await call<MessagingOperationStatus>('status', { platform: requestedPlatform })
    if (requestedRevision !== revision) { throw new Error('消息平台操作已切换') }
    return { ...snapshot, revision: requestedRevision }
  }
  async function call<T>(operation: string, body?: unknown): Promise<T> {
    const response = await fetch(`${base}__entry/messaging/${operation}`, {
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
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
      platform = input.platform ?? platform
      revision++
      return call(input.operation, { ...input, platform })
    },
    reconnectUniAgentGate: (profile?: string) => {
      if (profile && profile !== 'default') { return Promise.reject(new Error('云端消息平台只支持默认实例。')) }
      platform = 'uniagentgate'
      revision++
      return call<UniAgentGateReconnectResult>('reconnect')
    },
    onMessagingStatus(callback: (status: MessagingOperationStatus) => void) {
      let active = true
      const tick = () => {
        if (!document.hidden) {
          void status().then(snapshot => { if (active) {callback(snapshot)} }).catch(() => undefined)
        }
      }
      tick()
      const timer = window.setInterval(tick, 6000)
      return () => { active = false; window.clearInterval(timer) }
    },
    request<T>(request: HermesApiRequest): Promise<T> | undefined {
      const [path, query] = request.path.split('?')
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
            platform = 'uniagentgate'
            revision++
            return call(body.enabled ? 'enable' : 'disable').then(() => ({ ok: true, platform: 'uniagentgate' }) as T)
          }
        }
        return Promise.reject(new Error('该平台或消息类型尚未接通云端。'))
      }
      return undefined
    }
  }
}
