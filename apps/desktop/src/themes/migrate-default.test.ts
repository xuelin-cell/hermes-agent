import { beforeEach, expect, it } from 'vitest'

import { persistString, persistStringRecord, storedString, storedStringRecord } from '@/lib/storage'

import { migrateDefaultTheme } from './migrate-default'

beforeEach(() => localStorage.clear())

it('migrates old default assignments while preserving custom themes and modes', () => {
  persistString('hermes-desktop-theme-v2', 'nous')
  persistStringRecord('hermes-desktop-profile-themes-v1', { work: 'nous', private: 'github', custom: 'my-theme' })
  persistString('hermes-desktop-mode-v1', 'dark')
  migrateDefaultTheme()
  expect(storedString('hermes-desktop-theme-v2')).toBe('uniwork')
  expect(storedStringRecord('hermes-desktop-profile-themes-v1')).toEqual({
    work: 'uniwork',
    private: 'github',
    custom: 'my-theme'
  })
  expect(storedString('hermes-desktop-mode-v1')).toBe('dark')
})

it('allows an explicit Nous selection after the one-time migration', () => {
  migrateDefaultTheme()
  persistString('hermes-desktop-theme-v2', 'nous')
  migrateDefaultTheme()
  expect(storedString('hermes-desktop-theme-v2')).toBe('nous')
})
