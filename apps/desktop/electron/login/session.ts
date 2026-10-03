import type { LoginAccount, LoginResult } from './contract'
import type { CredentialStore } from './credential-store'

export interface LoginIdentity {
  uid: string
  token: string
  expiresAt: number
  maskedPhone: string
}

/** 判定 JSON 对象，拒绝数组及其他非字段结构。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 按已记录的登录协议解析可信上游响应，绝不补造身份或默认有效期。 */
function parseIdentity(body: unknown, phone: string): LoginIdentity | null {
  if (!isRecord(body) || (body.code !== undefined && body.code !== 0 && body.code !== '0')) {
    return null
  }

  const payload = body.data === undefined ? body : body.data

  if (!isRecord(payload)) {
    return null
  }

  const rawUid = payload.uid

  const uid =
    typeof rawUid === 'string'
      ? rawUid.trim()
      : typeof rawUid === 'number' && Number.isSafeInteger(rawUid) && rawUid >= 0
        ? String(rawUid)
        : ''

  if (!uid || typeof payload.token !== 'string' || !payload.token.trim()) {
    return null
  }

  const now = Date.now()
  const duration = payload.expireIn ?? payload.expires_in

  const expiresAt =
    payload.expiresAt ??
    (typeof duration === 'number' && Number.isFinite(duration) && duration > 0
      ? now + Math.floor(duration * 1000)
      : NaN)

  if (
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > 8_640_000_000_000_000
  ) {
    return null
  }

  return { uid, token: payload.token.trim(), expiresAt, maskedPhone: `${phone.slice(0, 3)}****${phone.slice(-4)}` }
}

/** 只挑选可跨越 IPC 的账号展示字段，不返回 UID、token 或原始响应。 */
function accountFor(identity: LoginIdentity): LoginAccount {
  return { maskedPhone: identity.maskedPhone, expiresAt: identity.expiresAt }
}

/** 管理短信登录和本地记录恢复的身份，关闭和过期后清除进程内凭据。 */
export class LoginSession {
  private identity: LoginIdentity | null = null
  private pending = false
  private closed = false
  private readonly cancellation = new AbortController()

  /** 注入主进程网络与必要的安全存储，页面不能替换请求或跳过持久化。 */
  constructor(
    private readonly request: typeof fetch,
    private readonly credentials: Pick<CredentialStore, 'save' | 'load'>
  ) {}

  /** 仅供主进程读取有效身份，返回副本以避免外部改写已校验记录。 */
  currentIdentity(): LoginIdentity | null {
    if (this.closed || !this.identity || this.identity.expiresAt <= Date.now()) {
      this.identity = null
    }

    return this.identity ? { ...this.identity } : null
  }

  /** 恢复经过存储模块校验且未到期的原账号；读取失败不改写记录。 */
  restore(): LoginResult {
    if (this.closed || this.pending) {
      return { ok: false }
    }

    const current = this.currentIdentity()

    if (current) {
      return { ok: true, account: accountFor(current) }
    }

    try {
      const saved = this.credentials.load()

      if (!saved || saved.expiresAt <= Date.now()) {
        return { ok: false }
      }

      this.identity = { uid: saved.uid, token: saved.token, expiresAt: saved.expiresAt, maskedPhone: saved.maskedPhone }

      return { ok: true, account: accountFor(this.identity) }
    } catch {
      return { ok: false }
    }
  }

  /** 阻止并发登录；全部字段合格后一次性保存身份，不保留半登录状态。 */
  async login(input: unknown): Promise<LoginResult> {
    if (
      this.closed ||
      this.pending ||
      !isRecord(input) ||
      typeof input.phone !== 'string' ||
      !/^1\d{10}$/.test(input.phone) ||
      typeof input.smsCode !== 'string' ||
      !/^\d{6}$/.test(input.smsCode)
    ) {
      return { ok: false }
    }

    const current = this.currentIdentity()

    if (current) {
      return { ok: true, account: accountFor(current) }
    }

    this.pending = true

    try {
      const response = await this.request('https://maas.ai-yuanjing.com/app/login/smsLogin', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: input.phone, smsCode: input.smsCode, origin: 'app', application: 'uniwork' }),
        signal: AbortSignal.any([AbortSignal.timeout(15_000), this.cancellation.signal]),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store'
      })

      if (!response.ok) {
        return { ok: false }
      }

      const identity = parseIdentity(await response.json(), input.phone)

      if (this.closed || !identity) {
        return { ok: false }
      }

      this.credentials.save(identity)
      this.identity = identity

      return { ok: true, account: accountFor(identity) }
    } catch {
      return { ok: false }
    } finally {
      this.pending = false
    }
  }

  /** 关闭窗口后撤销请求并清除凭据，迟到的响应不能重新建立身份。 */
  dispose(): void {
    this.closed = true
    this.identity = null
    this.cancellation.abort()
  }
}
