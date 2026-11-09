import { net } from 'electron'

import type { LoginIdentity } from '../login/session'
import { parseUniAgentGate, type UniAgentGateUpdate } from '../login/uniagentgate'

import { normalizePlanUsage, type PlanUsage, type PlanUsageResult, type PlanUsageSnapshot } from './contract'

const USAGE_CACHE_MS = 30_000

function identityKey(identity: LoginIdentity | null): string {
  return identity && identity.expiresAt > Date.now() ? `${identity.uid}\0${identity.token}` : ''
}

/** 仅用当前账号查询，合并请求并限时缓存，不接受页面传入凭据或地址。 */
export class PlanUsageClient {
  private key = ''
  private pending: Promise<PlanUsageResult> | null = null
  private cached: PlanUsageSnapshot | null = null
  private cachedUntil = 0

  /** 注入身份与网络，生产走 Electron 会话，测试可验证实际 HTTP。 */
  constructor(
    private readonly identity: () => LoginIdentity | null,
    private readonly request: typeof fetch = (input, options) => net.fetch(input, options),
    private readonly applyBinding?: (update: UniAgentGateUpdate) => Promise<void>
  ) {}

  /** 复用登录或推送查到的用量；从获取时算有效期，避免启动耗时延长缓存寿命。 */
  remember(identity: LoginIdentity, data: PlanUsage): void {
    const key = identityKey(identity)

    if (!key || key !== identityKey(this.identity())) {
      return
    }

    this.key = key
    this.pending = null
    this.cached = {
      status: 'available',
      data,
      account: { maskedPhone: identity.maskedPhone, expiresAt: identity.expiresAt }
    }
    this.cachedUntil = data.fetchedAt + USAGE_CACHE_MS
  }

  /** 旧数据仅供同一有效账号展示，读取它不会发起请求或延长有效期。 */
  cachedSnapshot(): PlanUsageSnapshot | null {
    const key = identityKey(this.identity())

    return key && key === this.key ? this.cached : null
  }

  clear(): void {
    this.key = ''
    this.pending = null
    this.cached = null
    this.cachedUntil = 0
  }

  /** 三十秒内直接复用成功结果，超时或手动刷新则重新查询。 */
  async load(force = false): Promise<PlanUsageResult> {
    const identity = this.identity()
    const key = identityKey(identity)

    if (key !== this.key) {
      this.clear()
      this.key = key
    }

    if (!identity || !key) {return { status: 'failed', reason: 'auth' }}

    if (!force && this.cached && Date.now() < this.cachedUntil) {return this.cached}

    if (this.pending) {return this.pending}

    const pending: Promise<PlanUsageResult> = this.fetch(identity, () => this.pending === pending)
      .then((result): PlanUsageResult => {
        if (this.key !== key || identityKey(this.identity()) !== key) {
          return { status: 'failed', reason: 'auth' }
        }

        if (this.pending !== pending) {
          return this.cached ?? { status: 'failed', reason: 'auth' }
        }

        if (result.status === 'available') {
          this.cached = result
          this.cachedUntil = Date.now() + USAGE_CACHE_MS
        } else if (result.reason === 'auth') {
          this.clear()
        }

        return result
      })
      .finally(() => {
        if (this.pending === pending) {this.pending = null}
      })

    this.pending = pending

    return pending
  }

  /** 固定上游并拒绝重定向，迟到响应不能跨账号，错误不透出服务端原文。 */
  private async fetch(identity: LoginIdentity, isPending: () => boolean): Promise<PlanUsageResult> {
    try {
      const response = await this.request('https://maas.ai-yuanjing.com/app/gateway/uniwork/my-plan', {
        headers: { Accept: 'application/json', Authorization: `Bearer ${identity.token}` },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store'
      })

      if (response.status === 401 || response.status === 403) {return { status: 'failed', reason: 'auth' }}

      if (!response.ok) {return { status: 'failed' }}
      const body: unknown = await response.json()
      const data = normalizePlanUsage(body, Date.now())
      const current = this.identity()

      if (
        !isPending() ||
        !current ||
        current.uid !== identity.uid ||
        current.token !== identity.token ||
        current.expiresAt <= Date.now()
      )
        {return { status: 'failed', reason: 'auth' }}

      // 用量刷新也读取 my-plan；同一可信响应中的个人绑定不能被展示白名单丢弃。
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        const envelope = body as Record<string, unknown>
        const update = parseUniAgentGate(envelope.data === undefined ? body : envelope.data)

        if (update.status === 'available' || update.status === 'clear') {
          try {
            await this.applyBinding?.(update)
          } catch {
            console.warn('[desktop-mt] 5G 绑定更新失败，请检查账号配置；套餐用量仍可查看。')
          }
        }
      }

      if (this.identity()?.token !== identity.token || identity.expiresAt <= Date.now()) {
        return { status: 'failed', reason: 'auth' }
      }

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
