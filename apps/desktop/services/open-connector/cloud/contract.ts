import { CONNECTOR_SPECS } from '../../../electron/open-connector/contract'

/** Credential forms and OAuth providers with an instance-local runtime. */
export const CLOUD_CONNECTOR_IDS = ['amap', 'youdao_note', 'wps_mcp', 'wecom_bot', 'ima',
  'qq_mail', 'netease_mail', 'aminer', 'qcc_mcp', 'eastmoney_mcp', 'ifind_mcp'] as const
export const CLOUD_CONNECTOR_SPECS = {
  ...Object.fromEntries(CLOUD_CONNECTOR_IDS.map(id => [id, CONNECTOR_SPECS[id]])),
  // The desktop public client only permits loopback callbacks. Cloud needs a registered client.
  ifind_mcp: { auth: 'oauth2', fields: ['clientId'] },
  // The user approves on Kingsoft's page; the instance runtime polls for the token and saves it.
  wps_mcp: { auth: 'browser_poll', fields: [] }
}
export const CLOUD_OAUTH_HOSTS: Record<string, string> = {
  qcc_mcp: 'agent.qcc.com', eastmoney_mcp: 'mkcs.dfcfs.com', ifind_mcp: 'upass.10jqka.com.cn'
}
export const CLOUD_BROWSER_AUTH_HOSTS: Record<string, string> = { wps_mcp: 'mcp-center.wps.cn' }
