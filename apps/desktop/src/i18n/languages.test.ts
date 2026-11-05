import { describe, expect, it } from 'vitest'

import { TRANSLATIONS } from './catalog'
import {
  DEFAULT_LOCALE,
  isLocale,
  isSupportedLocaleValue,
  LOCALE_OPTIONS,
  normalizeLocale,
  resolveInitialLocale
} from './languages'

describe('desktop i18n languages', () => {
  it('limits configuration and system-language resolution to the three desktop languages', () => {
    for (const removed of ['ja', 'ja-JP', 'ar', 'ar-SA', 'ru', 'ru-RU', 'fr', 'fr-CA', 'de', 'de-DE', 'es', 'es-MX']) {
      expect(isLocale(removed), removed).toBe(false)
      expect(isSupportedLocaleValue(removed), removed).toBe(false)
      expect(normalizeLocale(removed), removed).toBe('en')
      expect(resolveInitialLocale(removed, 'zh-TW'), removed).toBe('zh-hant')
      expect(resolveInitialLocale(removed, removed), removed).toBe('en')
    }

    expect(resolveInitialLocale('zh', 'en-GB')).toBe('zh')
    expect(resolveInitialLocale('zh-hant', 'zh-CN')).toBe('zh-hant')
    expect(resolveInitialLocale('en', 'zh-TW')).toBe('en')
    expect(resolveInitialLocale(undefined, 'zh-CN')).toBe('zh')
    expect(resolveInitialLocale(undefined, 'zh-HK')).toBe('zh-hant')
    expect(resolveInitialLocale(undefined, 'en-GB')).toBe('en')
  })
  it('normalizes supported locale aliases', () => {
    expect(normalizeLocale('en')).toBe('en')
    expect(normalizeLocale('EN-US')).toBe('en')
    expect(normalizeLocale('zh')).toBe('zh')
    expect(normalizeLocale('zh-CN')).toBe('zh')
    expect(normalizeLocale('zh-Hans')).toBe('zh')
    expect(normalizeLocale(' zh_hans_cn ')).toBe('zh')
    expect(normalizeLocale('zh-Hant')).toBe('zh-hant')
    expect(normalizeLocale('zh-TW')).toBe('zh-hant')
    expect(normalizeLocale('zh_HK')).toBe('zh-hant')
  })

  it('falls back to English for empty or unsupported values', () => {
    expect(normalizeLocale(null)).toBe(DEFAULT_LOCALE)
    expect(normalizeLocale('')).toBe(DEFAULT_LOCALE)
    expect(normalizeLocale('it')).toBe(DEFAULT_LOCALE)
  })

  it('distinguishes exact locale ids from supported config aliases', () => {
    expect(isSupportedLocaleValue('zh-CN')).toBe(true)
    expect(isSupportedLocaleValue('zh-TW')).toBe(true)
    expect(isSupportedLocaleValue('it')).toBe(false)
    expect(isLocale('zh-CN')).toBe(false)
    expect(isLocale('zh')).toBe(true)
    expect(isLocale('zh-hant')).toBe(true)
  })

  it('round-trips every picker option through its display.language value to a registered catalog', () => {
    for (const option of LOCALE_OPTIONS) {
      expect(normalizeLocale(option.configValue)).toBe(option.id)
      expect(TRANSLATIONS[option.id]).toBeDefined()
    }

    expect(Object.keys(TRANSLATIONS).sort()).toEqual(LOCALE_OPTIONS.map(option => option.id).sort())
  })
})
