import type { LoginIdentity } from '../login/session'

export const AGENT_MAIL_CLOUD_STATE_KEY = 'wo_mail_agent_mail_state_v1'
const ENDPOINT = 'https://mass.ai-yuanjing.com/app/gateway/users/config'

export interface AgentMailCloudState {
  enabled: boolean
  email?: string
  phone?: string
  updatedAt?: string
}

export type AgentMailCloudReadResult =
  | { status: 'available'; exists: boolean; state: AgentMailCloudState | null }
  | { status: 'failed'; reason: 'auth' | 'invalid-response' | 'network' }

export type AgentMailCloudWriteResult =
  { status: 'available' } | { status: 'failed'; reason: 'auth' | 'invalid-response' | 'network' }

function sameIdentity(a: LoginIdentity | null, b: LoginIdentity): boolean {
  return Boolean(a && a.uid === b.uid && a.token === b.token && a.phone === b.phone && a.expiresAt > Date.now())
}

function parseState(value: unknown): AgentMailCloudState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const row = value as Record<string, unknown>

  if (typeof row.enabled !== 'boolean') {
    return null
  }

  if (row.email !== undefined && typeof row.email !== 'string') {
    return null
  }

  if (row.phone !== undefined && typeof row.phone !== 'string') {
    return null
  }

  if (row.updatedAt !== undefined && typeof row.updatedAt !== 'string') {
    return null
  }

  return {
    enabled: row.enabled,
    ...(typeof row.email === 'string' ? { email: row.email } : {}),
    ...(typeof row.phone === 'string' ? { phone: row.phone } : {}),
    ...(typeof row.updatedAt === 'string' ? { updatedAt: row.updatedAt } : {})
  }
}

export class AgentMailCloudStateClient {
  constructor(
    private readonly identity: () => LoginIdentity | null,
    private readonly request: typeof fetch = fetch
  ) {}

  async read(expected: LoginIdentity): Promise<AgentMailCloudReadResult> {
    if (!sameIdentity(this.identity(), expected)) {
      return { status: 'failed', reason: 'auth' }
    }

    try {
      const response = await this.request(`${ENDPOINT}?key=${encodeURIComponent(AGENT_MAIL_CLOUD_STATE_KEY)}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${expected.token}` },
        signal: AbortSignal.timeout(10_000)
      })

      if (!sameIdentity(this.identity(), expected)) {
        return { status: 'failed', reason: 'auth' }
      }

      if (response.status === 404) {
        return { status: 'available', exists: false, state: null }
      }

      if (response.status === 401 || response.status === 403) {
        return { status: 'failed', reason: 'auth' }
      }

      if (!response.ok) {
        return { status: 'failed', reason: 'network' }
      }

      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null

      if (!body || body.key !== AGENT_MAIL_CLOUD_STATE_KEY || typeof body.value !== 'string') {
        return { status: 'failed', reason: 'invalid-response' }
      }

      let value: unknown

      try {
        value = JSON.parse(body.value)
      } catch {
        return { status: 'failed', reason: 'invalid-response' }
      }

      const state = parseState(value)

      return state ? { status: 'available', exists: true, state } : { status: 'failed', reason: 'invalid-response' }
    } catch {
      return { status: 'failed', reason: 'network' }
    }
  }

  async write(expected: LoginIdentity, state: AgentMailCloudState): Promise<AgentMailCloudWriteResult> {
    if (!sameIdentity(this.identity(), expected)) {
      return { status: 'failed', reason: 'auth' }
    }

    if (!parseState(state)) {
      return { status: 'failed', reason: 'invalid-response' }
    }

    try {
      const response = await this.request(ENDPOINT, {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${expected.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ key: AGENT_MAIL_CLOUD_STATE_KEY, value: JSON.stringify(state), valueType: 'json' }),
        signal: AbortSignal.timeout(10_000)
      })

      if (!sameIdentity(this.identity(), expected) || response.status === 401 || response.status === 403) {
        return { status: 'failed', reason: 'auth' }
      }

      if (!response.ok) {
        return { status: 'failed', reason: 'network' }
      }

      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null

      return body?.key === AGENT_MAIL_CLOUD_STATE_KEY
        ? { status: 'available' }
        : { status: 'failed', reason: 'invalid-response' }
    } catch {
      return { status: 'failed', reason: 'network' }
    }
  }
}
