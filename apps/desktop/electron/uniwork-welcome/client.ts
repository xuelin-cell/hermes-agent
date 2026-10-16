import { net } from 'electron'

import type { LoginIdentity } from '../login/session'

import { normalizeOfficeCatalog, type WelcomeCategory, type WelcomeLocale } from './catalog'

/** 主进程仅允许读取固定的中英文目录，凭据不交给页面或写入缓存。 */
export class WelcomeCatalogClient {
  /** 网络可注入以验证真实 HTTP 路径，业务调用始终使用 Electron 的网络会话。 */
  constructor(
    private readonly identity: () => LoginIdentity | null,
    private readonly request: typeof fetch = (input, options) => net.fetch(input, options)
  ) {}

  /** 每次用当前有效身份读取配置，解析失败保留页面已缓存的完整目录。 */
  async load(locale: WelcomeLocale): Promise<WelcomeCategory[]> {
    if (!['zh-CN', 'en'].includes(locale)) {
      throw new Error('办公模板语言无效。')
    }

    const identity = this.identity()

    if (!identity || identity.expiresAt <= Date.now()) {
      throw new Error('请重新登录后加载办公模板。')
    }

    const key = `welcome_config_codex_${locale}`

    try {
      const response = await this.request(`https://maas.ai-yuanjing.com/app/gateway/uniclaw/system-config?key=${key}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${identity.token}` },
        signal: AbortSignal.timeout(8_000),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store'
      })

      if (!response.ok || this.identity()?.token !== identity.token) {
        throw new Error()
      }

      const envelope = await response.json()

      if (typeof envelope?.configValue !== 'string' || envelope.configValue.length > 2_000_000) {
        throw new Error()
      }

      return normalizeOfficeCatalog(JSON.parse(envelope.configValue))
    } catch {
      throw new Error('办公模板更新失败，已保留本地模板。')
    }
  }
}
