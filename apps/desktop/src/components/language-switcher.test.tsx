import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesConfigRecord } from '@/hermes'
import { type I18nConfigClient, I18nProvider } from '@/i18n'
import { $developerMode } from '@/store/developer-mode'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { LanguageSwitcher } from './language-switcher'

stubResizeObserver()
stubMenuDomApis()
describe('LanguageSwitcher', () => {
  afterEach(() => {
    cleanup()
    $developerMode.set(false)
    vi.restoreAllMocks()
  })

  it('persists language changes through display.language config', async () => {
    const saveConfig = vi.fn().mockResolvedValue({ ok: true })
    const latestConfig: HermesConfigRecord = { display: { language: 'en', skin: 'slate' } }

    const configClient: I18nConfigClient = {
      getConfig: vi.fn().mockResolvedValue(latestConfig),
      saveConfig
    }

    render(
      <I18nProvider configClient={configClient}>
        <LanguageSwitcher />
      </I18nProvider>
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Switch language' }).hasAttribute('disabled')).toBe(false)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Switch language' }))
    expect(screen.queryByPlaceholderText('Search languages...')).toBeNull()
    act(() => $developerMode.set(true))
    expect(screen.getByRole('combobox')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'English' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    act(() => $developerMode.set(false))
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      'Englishen',
      '简体中文zh',
      '繁體中文zh-hant'
    ])
    fireEvent.click(screen.getByRole('option', { name: /繁體中文/i }))

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1))
    expect(saveConfig).toHaveBeenCalledWith({ display: { language: 'zh-hant', skin: 'slate' } })
  })
})
