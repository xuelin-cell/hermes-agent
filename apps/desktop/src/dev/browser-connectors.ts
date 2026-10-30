import type { LocalConnectorRequest, LocalConnectorResult } from '../../electron/open-connector/contract'
import { CLOUD_CONNECTOR_IDS, CLOUD_OAUTH_HOSTS } from '../../services/open-connector/cloud/contract'

/** Only verified providers are exposed. This API uses the entry session cookie. */
export function browserConnectors(base: string) {
  return {
    cloudConnectorIds: CLOUD_CONNECTOR_IDS,
    localConnectors: async (input: LocalConnectorRequest): Promise<LocalConnectorResult> => {
      if (!input.profile || input.profile.startsWith('.') || /[\\/]/.test(input.profile) || input.profile.length > 160 || (input.operation !== 'list' && !CLOUD_CONNECTOR_IDS.some(id => id === input.id)) ||
          !['list', 'connect', 'enable', 'disable', 'disconnect', 'save', 'authorize'].includes(input.operation)) {
        throw new Error('该连接器或授权方式尚未在云端开放。')
      }
      // Claim a window during the user's click; opening after fetch is blocked by browsers.
      let popup: Window | null = null
      if (input.operation === 'authorize') {
        if (!input.id || !Object.hasOwn(CLOUD_OAUTH_HOSTS, input.id)) throw new Error('该连接器不使用 OAuth 授权。')
        popup = window.open('about:blank', '_blank')
        if (!popup) throw new Error('请允许本站弹出授权窗口后重试。')
        popup.opener = null
      }
      try {
        const response = await fetch(`${base}__entry/connectors`, {
          method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
        })
        if (!response.ok) {
          const result = await response.json().catch(() => null) as { error?: string } | null
          throw new Error(result?.error || '连接器请求失败，请检查状态后重试。')
        }
        const result = await response.json() as LocalConnectorResult
        if (popup) {
          const url = new URL(result.authorizationUrl ?? '')
          if (url.protocol !== 'https:' || url.host !== CLOUD_OAUTH_HOSTS[input.id!] || url.username || url.password) {
            throw new Error('连接器授权地址无效。')
          }
          popup.location.replace(url.href)
        }
        return result
      } catch (error) {
        popup?.close()
        throw error
      }
    }
  }
}
