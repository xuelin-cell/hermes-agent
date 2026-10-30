/** Use the original OAuth flow/SQLite/refresh implementation with an Entry callback origin. */
import { createConnectApp, type ConnectAppOptions } from '../src/server/connect-app.ts'
import { CLOUD_OAUTH_HOSTS } from './contract.ts'

interface OAuthInput {
  operation: string
  id?: string
  origin?: string
  values?: Record<string, string>
  parameters?: Record<string, string>
}

export async function connectorOAuth(options: ConnectAppOptions, input: OAuthInput, signal: AbortSignal) {
  const id = input.id ?? ''
  if (!Object.hasOwn(CLOUD_OAUTH_HOSTS, id) || !input.origin) throw new Error('Unsupported OAuth provider')
  const origin = new URL(input.origin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash ||
      !origin.pathname.endsWith(`/__entry/connectors/${id}`)) throw new Error('Invalid Entry callback origin')
  // Each flow uses the origin bound by Entry. Reuse the existing encrypted SQLite stores,
  // including PKCE state, client registration, credential validation, and refresh tokens.
  const { app } = await createConnectApp({ ...options, publicOrigin: origin.href.replace(/\/$/, ''),
    allowedCustomOAuth: ['ifind_mcp'] })
  if (input.operation === 'authorize') {
    const clientId = input.values?.clientId
    if (id === 'ifind_mcp' && (!clientId?.trim() || Object.keys(input.values ?? {}).some(key => key !== 'clientId'))) {
      throw new Error('请填写已登记云端回调地址的 iFinD Client ID。')
    }
    const result = await app.request('/api/oauth/authorizations', { method: 'POST', signal,
      headers: { Authorization: `Bearer ${options.adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: id, connectionName: 'default',
        ...(id === 'ifind_mcp' ? { clientId, clientSecret: '' } : {}) }) })
    if (!result.ok) throw new Error('OAuth authorization failed')
    const data = await result.json() as { authorizationUrl: string; state: string }
    const url = new URL(data.authorizationUrl)
    if (url.protocol !== 'https:' || url.host !== CLOUD_OAUTH_HOSTS[id] || url.username || url.password || !data.state) {
      throw new Error('Invalid provider authorization URL')
    }
    return { authorizationUrl: url.href, state: data.state }
  }
  const parameters = input.parameters ?? {}
  if (!parameters.state || !parameters.code || parameters.error) throw new Error('OAuth callback denied')
  // Complete only a state created for this provider. take/set are the existing one-time
  // encrypted-state store operations; management requests are serialized by the parent.
  const pending = await options.runtimeDatabase.oauthStateStore.take(parameters.state)
  if (!pending) throw new Error('OAuth state expired')
  if (pending.service !== id) throw new Error('OAuth provider mismatch')
  await options.runtimeDatabase.oauthStateStore.set(pending)
  const result = await app.request('/oauth/callback?' + new URLSearchParams(parameters), { signal })
  if (!result.ok) throw new Error('OAuth callback failed')
  return { ok: true }
}
