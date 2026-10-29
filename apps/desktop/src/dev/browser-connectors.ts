import type { LocalConnectorRequest, LocalConnectorResult } from '../../electron/open-connector/contract'
import { CLOUD_CONNECTOR_IDS } from '../../services/open-connector/cloud/contract'

/** Only verified providers are exposed. This API uses the entry session cookie. */
export function browserConnectors(base: string) {
  return {
    cloudConnectorIds: CLOUD_CONNECTOR_IDS,
    localConnectors: async (input: LocalConnectorRequest): Promise<LocalConnectorResult> => {
      if (input.profile !== 'default' || (input.operation !== 'list' && !CLOUD_CONNECTOR_IDS.some(id => id === input.id)) ||
          !['list', 'connect', 'enable', 'disable', 'disconnect', 'save'].includes(input.operation)) {
        throw new Error('该连接器或授权方式尚未在云端开放。')
      }
      const response = await fetch(`${base}__entry/connectors`, {
        method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
      })
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(result?.error || '连接器请求失败，请检查状态后重试。')
      }
      return response.json() as Promise<LocalConnectorResult>
    }
  }
}
