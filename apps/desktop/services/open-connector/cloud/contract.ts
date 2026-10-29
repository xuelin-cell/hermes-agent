import { CONNECTOR_SPECS } from '../../../electron/open-connector/contract'

/** Providers with an instance runtime and a credential form; OAuth/QR are separate flows. */
export const CLOUD_CONNECTOR_IDS = ['amap', 'youdao_note', 'wps_mcp', 'wecom_bot', 'ima'] as const
export const CLOUD_CONNECTOR_SPECS = Object.fromEntries(CLOUD_CONNECTOR_IDS.map(id => [id, CONNECTOR_SPECS[id]]))
