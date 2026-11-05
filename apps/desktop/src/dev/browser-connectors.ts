import type { LocalConnectorRequest, LocalConnectorResult } from '../../electron/open-connector/contract'
import { CLOUD_BROWSER_AUTH_HOSTS, CLOUD_CONNECTOR_IDS, CLOUD_OAUTH_HOSTS } from '../../services/open-connector/cloud/contract'

// Pages the authorize popup may land on: OAuth providers and provider-page polling (WPS).
const AUTHORIZATION_HOSTS: Record<string, string> = { ...CLOUD_OAUTH_HOSTS, ...CLOUD_BROWSER_AUTH_HOSTS }

/** Entry runs the WeCom scan and keeps the bot secret; the browser only draws the QR link. */
async function wecomQrImage(link: string | undefined): Promise<string> {
  const url = new URL(link ?? '')

  if (url.protocol !== 'https:' || url.hostname !== 'work.weixin.qq.com' || url.username || url.password) {
    throw new Error('企业微信返回的二维码地址无效。')
  }

  const { default: QRCode } = await import('qrcode')

  return QRCode.toDataURL(url.href, { width: 240, margin: 2 })
}

/** Only verified providers are exposed. This API uses the entry session cookie. */
export function browserConnectors(base: string) {
  return {
    cloudConnectorIds: CLOUD_CONNECTOR_IDS,
    localConnectors: async (input: LocalConnectorRequest): Promise<LocalConnectorResult> => {
      const qr = input.operation.startsWith('qr.')

      if (!input.profile || input.profile.startsWith('.') || /[\\/]/.test(input.profile) || input.profile.length > 160 || (input.operation !== 'list' && !CLOUD_CONNECTOR_IDS.some(id => id === input.id)) ||
          (qr && input.id !== 'wecom_bot') ||
          (input.operation.startsWith('authorize.') && !(input.id && Object.hasOwn(CLOUD_BROWSER_AUTH_HOSTS, input.id))) ||
          !['list', 'connect', 'enable', 'disable', 'disconnect', 'save', 'authorize', 'authorize.poll', 'authorize.cancel',
            'qr.start', 'qr.poll', 'qr.cancel'].includes(input.operation)) {
        throw new Error('该连接器或授权方式尚未在云端开放。')
      }
      // Claim a window during the user's click; opening after fetch is blocked by browsers.
      let popup: Window | null = null
      if (input.operation === 'authorize') {
        if (!input.id || !Object.hasOwn(AUTHORIZATION_HOSTS, input.id)) throw new Error('该连接器不使用授权页授权。')
        popup = window.open('about:blank', '_blank')
        if (!popup) throw new Error('请允许本站弹出授权窗口后重试。')
        popup.opener = null
        // The provider URL arrives after a round trip to the instance; say so instead of a blank page.
        popup.document.title = '正在打开授权页…'
        popup.document.body.textContent = '正在打开授权页…'
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
        const result = await response.json() as LocalConnectorResult & { authUrl?: string }

        if (input.operation === 'qr.start') {
          return { connectors: result.connectors, sessionId: result.sessionId, qrState: result.qrState, qrImage: await wecomQrImage(result.authUrl) }
        }

        if (popup) {
          const url = new URL(result.authorizationUrl ?? '')
          if (url.protocol !== 'https:' || url.host !== AUTHORIZATION_HOSTS[input.id!] || url.username || url.password) {
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
