import { expect, it } from 'vitest'

import { TRANSLATIONS } from './catalog'
import type { Locale } from './types'

const names: Record<Locale, string> = { en: 'Connect Phone', zh: '连接手机', 'zh-hant': '連接手機' }

/** 收集合并后的可展示文案，包含缺译时从英文继承的字符串。 */
function textLeaves(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }

  return value && typeof value === 'object' ? Object.values(value).flatMap(textLeaves) : []
}

it('三种语言的侧栏、命令入口、快捷键和移交指引使用同一功能名称', () => {
  for (const locale of Object.keys(names) as Locale[]) {
    const copy = TRANSLATIONS[locale]
    expect(copy.sidebar.nav.messaging).toBe(names[locale])
    expect(copy.commandCenter.nav.messaging.title).toBe(names[locale])
    expect(copy.keybinds.actions['nav.messaging']).toContain(names[locale])
    expect(copy.desktop.handoff.timedOut).toContain(names[locale])
  }
})

it('三种语言的合并文案不残留消息平台旧称或旧入口指引', () => {
  const obsolete = /消息平台|訊息平台|\bmessaging platforms?\b|Settings\s*→\s*Messaging|\bOpen messaging\b/i

  for (const locale of Object.keys(names) as Locale[]) {
    expect(textLeaves(TRANSLATIONS[locale]).filter(text => obsolete.test(text))).toEqual([])
  }
})
