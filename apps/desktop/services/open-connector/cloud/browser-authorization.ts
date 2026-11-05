/** Browser-poll authorization (WPS): the user approves on the provider's page while this runtime
 * polls the provider and saves the token itself, so no credential crosses the instance boundary. */

interface ScopeApp { request(path: string, init: RequestInit): Response | Promise<Response> }
interface AuthorizationInput { operation: string; id?: string; sessionId?: string }

const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/

export async function browserAuthorization(
  app: ScopeApp, admin: string, input: AuthorizationInput, signal: AbortSignal
): Promise<[unknown, number]> {
  const base = `/api/browser-authorizations/${encodeURIComponent(input.id ?? '')}`
  if (input.operation !== 'authorize' && !(typeof input.sessionId === 'string' && SESSION_ID.test(input.sessionId))) {
    return [{ error: 'Invalid authorization session' }, 400]
  }
  const start = input.operation === 'authorize'
  const result = await app.request(start ? base : `${base}/${input.sessionId}`, {
    method: start ? 'POST' : input.operation === 'authorize.poll' ? 'GET' : 'DELETE',
    signal,
    headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
    ...(start ? { body: JSON.stringify({ connectionName: 'default' }) } : {})
  })
  const body = await result.json().catch(() => null) as Record<string, unknown> | null
  if (!result.ok || !body) {
    const message = (body?.error as { message?: unknown } | undefined)?.message
    return [{ error: typeof message === 'string' ? message : '无法完成 WPS 授权，请稍后重试。' }, result.status === 404 ? 404 : 409]
  }
  // Session state only: the token stays in this runtime's encrypted store.
  const pick = (key: string) => (typeof body[key] === 'string' ? body[key] : undefined)
  return [{ sessionId: pick('sessionId'), status: pick('status'), message: pick('message'),
    expiresAt: pick('expiresAt'), authorizationUrl: pick('authorizationUrl') }, 200]
}
