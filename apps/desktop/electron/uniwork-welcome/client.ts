import type { LoginIdentity } from '../login/session'

import { normalizeWelcomeCatalog, type WelcomeLocale, type WelcomePayload } from './catalog'

/** 只使用当前有效登录身份读取配置；页面仅能选择固定中英文记录。 */
export class WelcomeCatalogClient {
  /** 网络可注入以验证真实 HTTP 路径，业务调用始终使用 Electron 的网络会话。 */
  constructor(
    private readonly request: typeof fetch,
    private readonly identity?: () => LoginIdentity | null
  ) {}

  /** 解析失败保留页面已缓存的完整目录。 */
  async load(locale: WelcomeLocale): Promise<WelcomePayload> {
    if (!['zh-CN', 'en'].includes(locale)) {
      throw new Error('办公模板语言无效。')
    }

    const key = `welcome_config_v3_${locale}`
    const identity = this.identity?.()
    const token = identity && identity.expiresAt > Date.now() ? identity.token : null

    try {
      if (!token) {
        throw new Error('标签配置需要当前登录身份')
      }

      const response = await this.request(`https://maas.ai-yuanjing.com/app/gateway/uniwork/system-config?key=${key}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store'
      })

      if (!response.ok) {
        throw new Error()
      }

      const envelope = await response.json()

      if (typeof envelope?.configValue !== 'string' || envelope.configValue.length > 2_000_000) {
        throw new Error()
      }

      const payload = JSON.parse(envelope.configValue)

      const current = this.identity?.()

      if (!normalizeWelcomeCatalog(payload).length || current?.token !== token || current.expiresAt <= Date.now()) {
        throw new Error()
      }

      return {
        modules: payload.modules,
        ...(typeof envelope.version === 'string' && envelope.version.trim() ? { version: envelope.version.trim() } : {})
      }
    } catch {
      throw new Error('办公模板更新失败，已保留本地模板。')
    }
  }
}
