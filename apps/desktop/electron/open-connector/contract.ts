export const CONNECTOR_CHANNEL = 'hermes:open-connector'

export const CONNECTOR_SPECS = {
  qq_mail: { auth: 'custom_credential', fields: ['email', 'authorizationCode'] },
  netease_mail: { auth: 'custom_credential', fields: ['email', 'authorizationCode'] },
  amap: { auth: 'api_key', fields: ['apiKey'] },
  wps_mcp: { auth: 'api_key', fields: ['apiKey'] },
  youdao_note: { auth: 'api_key', fields: ['apiKey'] },
  ima: { auth: 'custom_credential', fields: ['clientId', 'apiKey'] },
  qcc_mcp: { auth: 'oauth2', fields: [] },
  eastmoney_mcp: { auth: 'oauth2', fields: [] },
  ifind_mcp: { auth: 'oauth2', fields: [] },
  aminer: { auth: 'api_key', fields: ['apiKey'] },
  wecom_bot: { auth: 'custom_credential', fields: ['botId', 'secret'] }
} as const

export type ConnectorId = keyof typeof CONNECTOR_SPECS
export interface LocalConnectorRow {
  id: ConnectorId
  connected: boolean
}
export interface LocalConnectorRequest {
  operation: 'list' | 'connect' | 'authorize' | 'disconnect' | 'enable' | 'qr.start' | 'qr.poll' | 'qr.cancel'
  profile: string
  id?: ConnectorId
  values?: Record<string, string>
  sessionId?: string
}
export interface LocalConnectorResult {
  connectors: LocalConnectorRow[]
  authorizationUrl?: string
  sessionId?: string
  qrImage?: string
  qrState?: 'pending' | 'scanned' | 'confirmed' | 'expired'
}
