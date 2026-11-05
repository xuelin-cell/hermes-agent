import { expect, it } from 'vitest'

import { TRANSLATIONS } from './catalog'

// 法、德、西语的专用完整性检查随资源移除；保留中文退役提示的既有约束。
it.each(['zh', 'zh-hant'] as const)('%s renders localized retirement copy instead of English fallback', locale => {
  expect(TRANSLATIONS[locale].updates.discontinuedTitle).not.toBe(TRANSLATIONS.en.updates.discontinuedTitle)
  expect(TRANSLATIONS[locale].updates.discontinuedBody).not.toBe(TRANSLATIONS.en.updates.discontinuedBody)
})
