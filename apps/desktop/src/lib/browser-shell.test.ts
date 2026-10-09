import { afterEach, describe, expect, it } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n/runtime'

import {
  browserShellCopy,
  isBrowserShell,
  isInstanceLocalUrl,
  isSettingsViewHidden,
  withoutHiddenPaletteItems
} from './browser-shell'

afterEach(() => {
  delete document.documentElement.dataset.hermesBrowser
  setRuntimeI18nLocale('en')
})

describe('browser shell', () => {
  it('is on only where the browser bridge marked the document', () => {
    expect(isBrowserShell()).toBe(false)
    expect(isSettingsViewHidden('gateway')).toBe(false)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(isBrowserShell()).toBe(true)
    expect(['gateway', 'connections', 'about'].map(isSettingsViewHidden)).toEqual([true, true, true])
    expect(isSettingsViewHidden('config:model')).toBe(false)
  })

  it('recognises addresses on the agent’s own machine', () => {
    for (const url of [
      'http://localhost:3000/',
      'http://127.0.0.1:8080/x',
      'http://0.0.0.0:5173',
      'https://[::1]:3000/'
    ]) {
      expect(isInstanceLocalUrl(url)).toBe(true)
    }

    for (const url of [
      'https://example.com',
      'http://192.168.2.71:18081/hermes/',
      'http://localhost.example.com/',
      'mailto:someone@example.com',
      'not a url'
    ]) {
      expect(isInstanceLocalUrl(url)).toBe(false)
    }
  })

  it('drops desktop-only palette rows and the groups they leave empty', () => {
    const groups = [
      { heading: 'theme', items: [{ id: 'theme-install' }] },
      { heading: 'command center', items: [{ id: 'cc-update-hermes' }, { id: 'cc-reload-window' }] }
    ]

    expect(withoutHiddenPaletteItems(groups)).toBe(groups)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(withoutHiddenPaletteItems(groups)).toEqual([
      { heading: 'command center', items: [{ id: 'cc-reload-window' }] }
    ])
  })

  it('speaks the interface language', () => {
    expect(browserShellCopy().deleteConfirm).toBe('Delete permanently')

    setRuntimeI18nLocale('zh')

    expect(browserShellCopy().deleteBody(false)).toBe('将永久删除，无法恢复。')
    expect(browserShellCopy().deleteBody(true)).toContain('文件夹')
  })
})
