import type { HermesApiRequest } from '@/global'
import type { MessagingOperationStatus, MessagingSetupRequest, MessagingSetupResult } from '../../electron/entry_local/messaging-contract'
import type { UniAgentGateReconnectResult } from '../../electron/entry_local/uniagentgate-contract'

/** Fixed, cookie-authenticated entry routes; no MaaS credential enters this bridge. */
export function browserMessaging(base: string) {
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
    messagingStatus: () => call<MessagingOperationStatus>('status'),
    messagingSetup: (input: MessagingSetupRequest): Promise<MessagingSetupResult> => {
      if (input.operation !== 'watch' || input.platform || (input.profile && input.profile !== 'default')) {
        return Promise.reject(new Error('云端首期仅支持 5G 文本消息，请使用 5G 卡片连接。'))
      }
      return call('watch', input).then(() => ({ accepted: true }))
    },
    reconnectUniAgentGate: (profile?: string) => profile && profile !== 'default'
      ? Promise.reject(new Error('云端消息平台只支持默认实例。'))
      : call<UniAgentGateReconnectResult>('reconnect'),
    onMessagingStatus(callback: (status: MessagingOperationStatus) => void) {
      let active = true
      const tick = () => {
        if (!document.hidden) {
          void call<MessagingOperationStatus>('status').then(status => { if (active) {callback(status)} }).catch(() => undefined)
        }
      }
      tick()
      const timer = window.setInterval(tick, 6000)
      return () => { active = false; window.clearInterval(timer) }
    },
    request<T>(request: HermesApiRequest): Promise<T> | undefined {
      if (request.profile && request.profile !== 'default' && (request.path.startsWith('/api/messaging/') || request.path === '/api/plugins/desktop-messaging/platforms')) {
        return Promise.reject(new Error('云端消息平台只支持默认实例。'))
      }
      if (request.path === '/api/plugins/desktop-messaging/platforms' && (!request.method || request.method === 'GET')) {
        return call<T>('platforms')
      }
      if (request.path.startsWith('/api/messaging/')) {
        if (request.path === '/api/messaging/platforms/uniagentgate' && request.method === 'PUT') {
          const body = request.body as { enabled?: boolean; env?: unknown }
          if (typeof body?.enabled === 'boolean' && !body.env) {
            return call(body.enabled ? 'enable' : 'disable').then(() => ({ ok: true, platform: 'uniagentgate' }) as T)
          }
        }
        return Promise.reject(new Error('云端首期仅支持 5G 文本消息，其他平台与媒体接入尚未开放。'))
      }
      return undefined
    }
  }
}
