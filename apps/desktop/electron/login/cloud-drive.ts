import type { CloudDriveRequest } from './contract'
import type { LoginIdentity } from './session'

const BASE = 'https://maas.ai-yuanjing.com/app/uniwork/general_uniclaw/clouddrive/v1'
const AUTH = 'https://www.yjworker.10010.com/app/gateway/uniwork-yunpan/access-token'

/** 主进程持有云盘凭据，固定上游与操作范围；不将 token 返回页面。 */
export class CloudDriveClient {
  private token = ''
  private owner = ''
  private pending: Promise<string> | null = null

  /** 身份由登录模块提供，测试可替换网络但不能让页面选择上游。 */
  constructor(
    private readonly identity: () => LoginIdentity | null,
    private readonly request: typeof fetch = fetch
  ) {}

  /** 同一登录合并认证请求，账号或登录 token 变化后丢弃缓存。 */
  private async authenticate(identity: LoginIdentity): Promise<string> {
    if (this.owner !== identity.token) {
      this.owner = identity.token
      this.token = ''
      this.pending = null
    }

    if (this.token) {
      return this.token
    }

    this.pending ??= (async () => {
      const response = await this.request(AUTH, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: identity.phone, appVersion: '0.17.0' })
      })

      const payload = await response.json()
      const token = payload?.result?.accessToken

      if (
        !response.ok ||
        !payload?.meta ||
        !['', '0', '200'].includes(String(payload.meta.code ?? '')) ||
        typeof token !== 'string' ||
        !token.trim()
      ) {
        throw new Error('个人云盘认证失败，请稍后重试')
      }

      if (this.identity()?.token !== identity.token) {
        throw new Error('登录状态已变化，请重新打开资料库')
      }

      this.token = token

      return token
    })()

    try {
      return await this.pending
    } finally {
      this.pending = null
    }
  }

  /** 只转发云盘业务操作，并在服务明确报告云盘令牌过期时刷新一次。 */
  async execute(input: CloudDriveRequest): Promise<unknown> {
    const identity = this.identity()

    if (!identity || identity.expiresAt <= Date.now()) {
      throw new Error('请重新登录 UniWork')
    }

    if (!identity.phone || !/^1\d{10}$/.test(identity.phone)) {
      throw new Error('请退出账号并重新登录一次，以启用个人云盘')
    }

    if (!input || typeof input.route !== 'string') {
      throw new Error('云盘请求无效')
    }

    const method = input.method ?? 'GET'
    const route = input.route.split('?')[0]

    const allowed = {
      GET: [/^\/asset-spaces$/, /^\/asset-spaces\/[^/]+\/usage$/, /^\/assets$/, /^\/drive\/capabilities$/],
      POST: [/^\/folders$/, /^\/assets\/(move|trash|download)$/, /^\/unicom\/FileDetails$/],
      PATCH: [/^\/assets\/[^/]+$/]
    }

    if (
      !allowed[method]?.some(pattern => pattern.test(route)) ||
      /[\\\r\n#]/.test(input.route) ||
      /%(?:2e|2f|5c)/i.test(route) ||
      route.includes('..')
    ) {
      throw new Error('云盘操作不受支持')
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.authenticate(identity)

      const response = await this.request(BASE + input.route, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
        headers: {
          Authorization: `Bearer ${identity.token}`,
          'X-Drive-Access-Token': token,
          'Content-Type': 'application/json'
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {})
      })

      const payload = await response.json()

      if (this.identity()?.token !== identity.token) {
        throw new Error('登录状态已变化，请重新打开资料库')
      }

      const expired =
        payload?.error?.code === 'DRIVE_AUTH_EXPIRED' || String(payload?.error?.provider_code ?? '') === '9999'

      if (expired && attempt === 0) {
        this.token = ''

        continue
      }

      if (!response.ok || payload?.ok !== true) {
        throw new Error(response.status === 401 ? '登录已失效，请重新登录' : '个人云盘服务暂时不可用，请重试')
      }

      return payload.data
    }

    throw new Error('个人云盘认证失败，请重试')
  }
}
