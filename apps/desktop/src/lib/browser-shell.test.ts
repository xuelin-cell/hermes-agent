import { afterEach, describe, expect, it } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n/runtime'

import {
  browserShellCopy,
  isBrowserShell,
  isInstanceLocalUrl,
  isSettingsViewHidden,
  withoutHiddenNavItems,
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
      {
        heading: 'command center',
        items: [{ id: 'cc-update-hermes' }, { id: 'cc-restart-gateway' }, { id: 'cc-reload-window' }]
      }
    ]

    expect(withoutHiddenPaletteItems(groups)).toBe(groups)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(withoutHiddenPaletteItems(groups)).toEqual([
      { heading: 'command center', items: [{ id: 'cc-reload-window' }] }
    ])
  })

  it('drops the messaging platforms entry from the sidebar', () => {
    const nav = [{ id: 'new-session' }, { id: 'skills' }, { id: 'messaging' }, { id: 'artifacts' }]

    expect(withoutHiddenNavItems(nav)).toBe(nav)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(withoutHiddenNavItems(nav).map(item => item.id)).toEqual(['new-session', 'skills', 'artifacts'])
  })

  it('speaks the interface language', () => {
    expect(browserShellCopy().deleteConfirm).toBe('Delete')
    expect(browserShellCopy().fileErrors.exists).toMatch(/already exists/)

    setRuntimeI18nLocale('zh')

    expect(browserShellCopy().deleteBody(false)).toBe('将移到回收站，7 天内可以撤销。')
    expect(browserShellCopy().deleteBody(true)).toContain('文件夹')
    expect(browserShellCopy().movedToTrash('a.md')).toContain('a.md')
  })
})
