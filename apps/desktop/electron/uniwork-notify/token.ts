import { net } from 'electron'

import type { LoginIdentity } from '../login/session'

import type { NtfyReason } from './contract'

/** 账号网关换订阅凭证；凭证等同于接收权限，只允许留在主进程。 */
const TOKEN_URL = 'https://maas.ai-yuanjing.com/app/gateway/uniwork/ntfy-token'

/** 提前量：临近过期的凭证换掉比带着它去订阅更省一次失败重连。 */
const EXPIRY_MARGIN_MS = 60_000

/** 换取订阅凭证失败时的分类，调用方据此决定退避档位。 */
export class NtfyTokenError extends Error {
  constructor(readonly reason: Extract<NtfyReason, 'auth' | 'network' | 'protocol' | 'throttled' | 'unconfigured'>) {
    super(`ntfy-token ${reason}`)
  }
}

interface CachedToken {
  /** 缓存归属：uid + 登录 token，账号或登录态一变就作废。 */
  key: string
  token: string
  expiresAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 解析一次换取结果。`expires` 是 Unix 秒；缺字段或形态不对按协议错误处理，
 * 绝不补造凭证或默认有效期。
 */
export function parseNtfyToken(body: unknown, now = Date.now()): { expiresAt: number; token: string } {
  if (!isRecord(body) || (body.code !== undefined && body.code !== 0 && body.code !== '0')) {
    throw new NtfyTokenError('protocol')
  }

  const payload = body.data === undefined ? body : body.data

  if (!isRecord(payload)) {
    throw new NtfyTokenError('protocol')
  }

  const token = typeof payload.token === 'string' ? payload.token.trim() : ''
  const expires = payload.expires

  if (!token || typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0) {
    throw new NtfyTokenError('protocol')
  }

  const expiresAt = Math.floor(expires) * 1000

  if (expiresAt <= now) {
    throw new NtfyTokenError('protocol')
  }

  return { expiresAt, token }
}

export interface NtfyTokenOptions {
  /** 网络、时钟与日志可注入，测试据实际 HTTP 与缓存窗口断言。 */
  request?: typeof fetch
  now?: () => number
  log?: (line: string) => void
}

/** 用一个有效登录身份换订阅凭证，并在有效期内复用；重取即替换。 */
export class NtfyTokenClient {
  private readonly request: typeof fetch
  private readonly now: () => number
  private readonly log: (line: string) => void
  private cached: CachedToken | null = null
  private pending: Promise<string> | null = null

  constructor(private readonly identity: () => LoginIdentity | null, options: NtfyTokenOptions = {}) {
    this.request = options.request ?? ((input, init) => net.fetch(input, init))
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => undefined)
  }

  /** 当前可用的订阅凭证；无有效登录身份时按凭证失效处理。 */
  async get(): Promise<string> {
    const identity = this.identity()

    if (!identity || identity.expiresAt <= this.now() || !identity.token) {
      this.cached = null
      throw new NtfyTokenError('auth')
    }

    const key = `${identity.uid}\0${identity.token}`
    const cached = this.cached

    if (cached && cached.key === key && cached.expiresAt - EXPIRY_MARGIN_MS > this.now()) {
      this.log('ntfy 复用缓存的订阅凭证')

      return cached.token
    }

    if (this.pending) {
      return this.pending
    }

    const pending = this.exchange(identity, key).finally(() => {
      if (this.pending === pending) {
        this.pending = null
      }
    })

    this.pending = pending

    return pending
  }

  /** 服务端判定凭证失效时丢弃缓存，下次 get() 整条重取。 */
  invalidate(): void {
    this.cached = null
  }

  private async exchange(identity: LoginIdentity, key: string): Promise<string> {
    let response: Response

    try {
      response = await this.request(TOKEN_URL, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${identity.token}` },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store'
      })
    } catch {
      throw new NtfyTokenError('network')
    }

    if (response.status === 401 || response.status === 403) {
      throw new NtfyTokenError('auth')
    }

    if (response.status === 404) {
      throw new NtfyTokenError('unconfigured')
    }

    if (response.status === 429) {
      throw new NtfyTokenError('throttled')
    }

    if (!response.ok) {
      throw new NtfyTokenError('network')
    }

    let body: unknown

    try {
      body = await response.json()
    } catch {
      throw new NtfyTokenError('protocol')
    }

    const parsed = parseNtfyToken(body, this.now())

    // 换取期间的账号切换不能把上一个账号的凭证留在缓存里。
    if (this.identity()?.token !== identity.token) {
      throw new NtfyTokenError('auth')
    }

    this.cached = { ...parsed, key }
    this.log('ntfy 换取到新的订阅凭证')

    return parsed.token
  }
}
