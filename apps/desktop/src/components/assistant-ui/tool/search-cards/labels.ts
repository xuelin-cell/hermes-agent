import { translateNow } from '@/i18n'
import type { Translations } from '@/i18n/types'

/** 沿Hermes当前语言读取卡片文案，不建立独立语言状态。 */
export function cardText(key: keyof Translations['assistant']['searchCards']): string {
  return translateNow(`assistant.searchCards.${key}`)
}
