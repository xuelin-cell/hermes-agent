import { getRuntimeI18nLocale } from '@/i18n/runtime'

// desktop-mt: what a session is called before it has a title (lib/chat-runtime.ts)
// follows the locale the app starts in; the upstream constant is English only.
export function newSessionTitle(english: string): string {
  const locale = getRuntimeI18nLocale()

  return locale === 'zh-hant' ? '新對話' : locale === 'zh' ? '新对话' : english
}
