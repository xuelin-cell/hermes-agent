import { LOCALE_ENDONYMS } from '@hermes/shared/i18n'

import { normalize } from '@/lib/text'

import type { Locale } from './types'

export const DEFAULT_LOCALE: Locale = 'en'
export const DEFAULT_INITIAL_LOCALE: Locale = 'zh'

export const LOCALE_OPTIONS = [
  {
    id: 'en',
    name: LOCALE_ENDONYMS.en,
    englishName: 'English',
    configValue: 'en'
  },
  {
    id: 'zh',
    name: LOCALE_ENDONYMS.zh,
    englishName: 'Simplified Chinese',
    configValue: 'zh'
  },
  {
    id: 'zh-hant',
    name: LOCALE_ENDONYMS['zh-hant'],
    englishName: 'Traditional Chinese',
    configValue: 'zh-hant'
  }
] as const satisfies readonly { configValue: string; englishName: string; id: Locale; name: string }[]

// `name` is the endonym (native name) shown in the picker so users recognize
// their language regardless of the current UI language. No country flags:
// languages are not countries. `englishName` is search-only (not shown) so an
// English speaker can type "simplified"/"traditional" to filter the list.
export const LOCALE_META: Record<Locale, { name: string; englishName: string }> = Object.fromEntries(
  LOCALE_OPTIONS.map(locale => [locale.id, { name: locale.name, englishName: locale.englishName }])
) as Record<Locale, { name: string; englishName: string }>

const LOCALE_ALIASES: Record<string, Locale> = {
  en: 'en',
  'en-us': 'en',
  en_us: 'en',
  zh: 'zh',
  'zh-cn': 'zh',
  zh_cn: 'zh',
  'zh-hans': 'zh',
  zh_hans: 'zh',
  'zh-hans-cn': 'zh',
  zh_hans_cn: 'zh',
  'zh-tw': 'zh-hant',
  zh_tw: 'zh-hant',
  'zh-hk': 'zh-hant',
  zh_hk: 'zh-hant',
  'zh-mo': 'zh-hant',
  zh_mo: 'zh-hant',
  'zh-hant': 'zh-hant',
  zh_hant: 'zh-hant',
  'zh-hant-tw': 'zh-hant',
  zh_hant_tw: 'zh-hant',
  'zh-hant-hk': 'zh-hant',
  zh_hant_hk: 'zh-hant'
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && LOCALE_OPTIONS.some(locale => locale.id === value)
}

export function normalizeLocale(value: unknown): Locale {
  if (typeof value !== 'string') {
    return DEFAULT_LOCALE
  }

  return LOCALE_ALIASES[normalize(value)] ?? DEFAULT_LOCALE
}

export function isSupportedLocaleValue(value: unknown): boolean {
  return typeof value === 'string' && LOCALE_ALIASES[normalize(value)] != null
}

/** 系统地区标签未列入别名时，仍可按支持的语言识别，例如 en-GB。 */
export function osPreferredLocale(tag: string | null | undefined): Locale | null {
  if (!tag) {
    return null
  }

  const exact = LOCALE_ALIASES[normalize(tag)]

  if (exact) {
    return exact
  }

  const base = tag.split(/[-_]/)[0]

  return (base && LOCALE_ALIASES[normalize(base)]) || null
}

/** An explicit choice must win even when it differs from the OS language. */
export function resolveInitialLocale(saved: string | null | undefined, osLocale: string | null | undefined): Locale {
  if (isSupportedLocaleValue(saved)) {
    return normalizeLocale(saved)
  }

  return osPreferredLocale(osLocale) ?? DEFAULT_LOCALE
}

export function localeConfigValue(locale: Locale): string {
  return LOCALE_OPTIONS.find(item => item.id === locale)?.configValue ?? DEFAULT_LOCALE
}
