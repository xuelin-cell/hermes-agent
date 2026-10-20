import { net } from 'electron'

import type { LoginIdentity } from '../login/session'
import { normalizePlanUsage, type PlanUsageResult } from './contract'

/** 仅用当前账号查询，合并请求并限时缓存，不接受页面传入凭据或地址。 */
export class PlanUsageClient {
  private key = ''
  private pending: Promise<PlanUsageResult> | null = null
  private cached: PlanUsageResult | null = null
  private cachedUntil = 0

  /** 注入身份与网络，生产走 Electron 会话，测试可验证实际 HTTP。 */
  constructor(
    private readonly identity: () => LoginIdentity | null,
    private readonly request: typeof fetch = (input, options) => net.fetch(input, options)
  ) {}

  /** 账号变化或过期立即清除缓存，成功结果只在内存复用三十秒；手动刷新可绕过缓存。 */
  async load(force = false): Promise<PlanUsageResult> {
    const identity = this.identity()
    const key = identity && identity.expiresAt > Date.now() ? `${identity.uid}\0${identity.token}` : ''
    if (key !== this.key) {
      this.key = key
      this.pending = null
      this.cached = null
      this.cachedUntil = 0
    }
    if (!identity || !key) return { status: 'failed', reason: 'auth' }
    if (!force && this.cached && Date.now() < this.cachedUntil) return this.cached
    if (this.pending) return this.pending
    const pending = this.fetch(identity)
      .then(result => {
        if (
          this.key === key &&
          this.identity()?.token === identity.token &&
          identity.expiresAt > Date.now() &&
          result.status === 'available'
        ) {
          this.cached = result
          this.cachedUntil = Date.now() + 30_000
        }
        return result
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null
      })
    this.pending = pending
    return pending
  }

  /** 固定上游并拒绝重定向，迟到响应不能跨账号，错误不透出服务端原文。 */
  private async fetch(identity: LoginIdentity): Promise<PlanUsageResult> {
    try {
      const response = await this.request('https://maas.ai-yuanjing.com/app/gateway/uniwork/my-plan', {
        headers: { Accept: 'application/json', Authorization: `Bearer ${identity.token}` },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store'
      })
      if (response.status === 401 || response.status === 403) return { status: 'failed', reason: 'auth' }
      if (!response.ok) return { status: 'failed' }
      const data = normalizePlanUsage(await response.json(), Date.now())
      const current = this.identity()
      if (
        !current ||
        current.uid !== identity.uid ||
        current.token !== identity.token ||
        current.expiresAt <= Date.now()
      )
        return { status: 'failed', reason: 'auth' }
      return {
        status: 'available',
        data,
        account: { maskedPhone: identity.maskedPhone, expiresAt: identity.expiresAt }
      }
    } catch {
      return { status: 'failed' }
    }
  }
}
