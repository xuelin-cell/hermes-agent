import { afterEach, describe, expect, it } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n/runtime'

import {
  browserShellCopy,
  hideForUsers,
  isBrowserShell,
  isBrowserTerminalPaste,
  isDeveloperMode,
  isInstanceLocalUrl,
  isSettingsViewHidden,
  visibleModelOptions,
  withoutHiddenNavItems,
  withoutHiddenPaletteItems
} from './browser-shell'

afterEach(() => {
  delete document.documentElement.dataset.hermesBrowser
  localStorage.removeItem('hermes.mt.developer')
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

  it('shows everything again in developer mode, but keeps what the browser build needs', () => {
    document.documentElement.dataset.hermesBrowser = 'production'

    expect(isDeveloperMode()).toBe(false)
    expect(hideForUsers()).toBe(true)

    localStorage.setItem('hermes.mt.developer', '1')

    expect(isDeveloperMode()).toBe(true)
    expect(hideForUsers()).toBe(false)
    expect(isSettingsViewHidden('gateway')).toBe(false)
    expect(withoutHiddenNavItems([{ id: 'messaging' }]).map(item => item.id)).toEqual(['messaging'])
    expect(withoutHiddenPaletteItems([{ items: [{ id: 'cc-restart-gateway' }] }])).toHaveLength(1)
    expect(isBrowserShell()).toBe(true)
  })

  it('leaves Ctrl+V and Ctrl+Shift+V in the terminal to the browser’s own paste', () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { key: 'v', ...init })

    expect(isBrowserTerminalPaste(key({ ctrlKey: true }))).toBe(false)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(isBrowserTerminalPaste(key({ ctrlKey: true }))).toBe(true)
    expect(isBrowserTerminalPaste(key({ ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(isBrowserTerminalPaste(key({}))).toBe(false)
    expect(isBrowserTerminalPaste(key({ ctrlKey: true, altKey: true }))).toBe(false)
    expect(isBrowserTerminalPaste(new KeyboardEvent('keydown', { ctrlKey: true, key: 'c' }))).toBe(false)
    expect(isBrowserTerminalPaste(new KeyboardEvent('keyup', { ctrlKey: true, key: 'v' }))).toBe(false)
  })

  it('lists only the platform providers in model pickers, plus the one in use', () => {
    const options = {
      model: 'deepseek-v4-flash',
      providers: [
        { is_user_defined: true, name: 'yuanjing', slug: 'yuanjing' },
        { authenticated: true, name: 'OpenCode Free', slug: 'opencode-free' },
        { authenticated: true, is_current: true, name: 'Z.AI', slug: 'zai' },
        { authenticated: false, name: 'Qwen Cloud', slug: 'qwen' }
      ]
    }

    expect(visibleModelOptions(options)).toBe(options)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(visibleModelOptions(options).providers.map(p => p.slug)).toEqual(['yuanjing', 'zai'])
    const bare: { model: string; providers?: [] } = { model: 'x' }

    expect(visibleModelOptions(bare)).toBe(bare)

    localStorage.setItem('hermes.mt.developer', '1')

    expect(visibleModelOptions(options)).toBe(options)
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
