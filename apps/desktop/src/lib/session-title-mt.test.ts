import { afterEach, describe, expect, it } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n/runtime'

import { newSessionTitle } from './session-title-mt'

afterEach(() => {
  setRuntimeI18nLocale('en')
})

describe('newSessionTitle', () => {
  it('names a session that has no title yet in the active locale', () => {
    setRuntimeI18nLocale('en')
    expect(newSessionTitle('New session')).toBe('New session')

    setRuntimeI18nLocale('zh')
    expect(newSessionTitle('New session')).toBe('新对话')

    setRuntimeI18nLocale('zh-hant')
    expect(newSessionTitle('New session')).toBe('新對話')

    setRuntimeI18nLocale('en')
    expect(newSessionTitle('New session')).toBe('New session')
  })
})
