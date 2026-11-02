import { loadWelcomeCatalog } from '@/app/chat/composer/work-templates/catalog-store'
import { getRuntimeI18nLocale } from '@/i18n/runtime'

import type { NtfyInstruction } from '../../electron/uniwork-notify/contract'

/**
 * 配置已在主进程落盘后广播：会话里的默认模型/推理档位与模型菜单各自重读一次。
 * 用窗口事件而不是全局 store —— 只有当前窗口的聊天面板需要重读。
 */
export const NTFY_CONFIG_REFRESHED_EVENT = 'hermes:ntfy-config-refreshed'

/**
 * 指令只在页面做「重读」，写盘在主进程：一条消息带多个 tag 时合并成一次刷新，
 * 内部按顺序执行。任一动作失败只记日志，不影响后续消息（F4）。
 */
export async function runNtfyInstruction(instruction: NtfyInstruction): Promise<void> {
  const plan = instruction.tags.includes('refresh_plan') || instruction.tags.includes('refresh_model_config')
  const tools = instruction.tags.includes('refresh_tool_config')

  if (plan) {
    const refresh = window.hermesDesktop?.ntfy?.refresh

    if (refresh) {
      const result = await refresh().catch(() => null)

      if (result?.status === 'failed') {
        console.warn('[ntfy] 套餐刷新失败，保留当前配置')
      }
    }
  }

  if (tools) {
    // 远端 system-config 记录由主进程按语言重新拉取；失败保留本地缓存。
    const locale = getRuntimeI18nLocale().startsWith('zh') ? 'zh-CN' : 'en'

    await loadWelcomeCatalog(locale, true)
  }

  if (!plan && !tools) {
    return
  }

  window.dispatchEvent(new CustomEvent(NTFY_CONFIG_REFRESHED_EVENT))
}
