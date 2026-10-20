import { net } from 'electron'

import { normalizeWelcomeCatalog, type WelcomeLocale, type WelcomeModule } from './catalog'

/** 与 hexagent 一致，欢迎配置匿名读取；页面仅能选择固定的中英文记录。 */
export class WelcomeCatalogClient {
  /** 网络可注入以验证真实 HTTP 路径，业务调用始终使用 Electron 的网络会话。 */
  constructor(private readonly request: typeof fetch = (input, options) => net.fetch(input, options)) {}

  /** 解析失败保留页面已缓存的完整目录。 */
  async load(locale: WelcomeLocale): Promise<WelcomeModule[]> {
    if (!['zh-CN', 'en'].includes(locale)) {
      throw new Error('办公模板语言无效。')
    }

    const key = `welcome_config_codex_${locale}`

    try {
      const response = await this.request(`https://maas.ai-yuanjing.com/app/gateway/uniwork/system-config?key=${key}`, {
        headers: { Accept: 'application/json' },
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

      return normalizeWelcomeCatalog(JSON.parse(envelope.configValue))
    } catch {
      throw new Error('办公模板更新失败，已保留本地模板。')
    }
  }
}
