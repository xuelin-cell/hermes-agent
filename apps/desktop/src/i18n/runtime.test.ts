import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { fieldCopyForSchemaKey } from '@/app/settings/field-copy'

import { TRANSLATIONS } from './catalog'
import { setRuntimeI18nLocale, translateNow } from './runtime'
import { zh } from './zh'

describe('desktop i18n runtime translator', () => {
  beforeEach(() => {
    setRuntimeI18nLocale('en')
  })

  afterEach(() => {
    setRuntimeI18nLocale('en')
  })

  it('translates string paths for the active runtime locale', () => {
    setRuntimeI18nLocale('zh')

    expect(translateNow('boot.ready')).toBe(zh.boot.ready)
    expect(translateNow('assistant.tool.statusRecovered')).toBe(zh.assistant.tool.statusRecovered)
    expect(translateNow('boot.ready')).not.toBe(TRANSLATIONS.en.boot.ready)
  })

  it('uses the localized connector title only for Chinese', () => {
    setRuntimeI18nLocale('zh')
    expect(translateNow('connectorsPage.title')).toBe('连接器')

    setRuntimeI18nLocale('en')
    expect(translateNow('connectorsPage.title')).toBe('Connectors')
  })

  it('passes arguments to function translations', () => {
    expect(translateNow('notifications.updateReadyMessage', 2)).toBe(
      TRANSLATIONS.en.notifications.updateReadyMessage(2)
    )
    expect(translateNow('notifications.updateReadyMessage', 2)).toContain('2')
  })

  it('keeps translated settings field copy addressable from schema keys', () => {
    const field = ['display', 'show_reasoning'].join('.')

    expect(fieldCopyForSchemaKey(zh.settings.fieldLabels, field)).toBeTypeOf('string')
    expect(fieldCopyForSchemaKey(zh.settings.fieldDescriptions, field)).toBeTypeOf('string')
  })

  it('falls back to English when the active locale cannot resolve a key', () => {
    const boot = TRANSLATIONS.ja.boot as { ready?: string }
    const originalReady = boot.ready

    try {
      boot.ready = undefined
      setRuntimeI18nLocale('ja')

      expect(translateNow('boot.ready')).toBe(TRANSLATIONS.en.boot.ready)
    } finally {
      boot.ready = originalReady
    }
  })

  it('fills new connector copy from English for partial locales', () => {
    expect(TRANSLATIONS.fr.connectorsPage.recommended.needAuth).toBe(
      TRANSLATIONS.en.connectorsPage.recommended.needAuth
    )
    expect(TRANSLATIONS.ja.connectorsPage.recommended.guides.netease_mail.title).toBe(
      TRANSLATIONS.en.connectorsPage.recommended.guides.netease_mail.title
    )
  })

  it('returns the key when no locale can resolve a path', () => {
    setRuntimeI18nLocale('zh')

    expect(translateNow('missing.path')).toBe('missing.path')
  })
})
