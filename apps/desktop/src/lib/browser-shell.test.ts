import { afterEach, describe, expect, it, vi } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n/runtime'

import {
  browserShellCopy,
  browserShellZoom,
  hideForUsers,
  HTML_PREVIEW_SANDBOX,
  isBrowserShell,
  isBrowserTerminalPaste,
  isBundledPluginHidden,
  isDeveloperMode,
  isInstanceLocalUrl,
  isSettingsViewHidden,
  remoteHtmlFrameDocument,
  remoteHtmlFrameSandbox,
  sidebarPageOutlivesReactivation,
  skillMarketInstallPending,
  visibleModelOptions,
  withoutHiddenNavItems,
  withoutHiddenPaletteItems
} from './browser-shell'

// UniWork's developer mode (store/developer-mode.ts), which the browser build follows.
const DEVELOPER_MODE_KEY = 'uniwork.desktop.developerMode.v1'

afterEach(() => {
  delete document.documentElement.dataset.hermesBrowser
  localStorage.removeItem(DEVELOPER_MODE_KEY)
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

  // A bundle chunk can evaluate a store before the bridge has marked the document.
  it('is on from the start in the production browser build, before the bridge has run', () => {
    vi.stubEnv('VITE_HERMES_BROWSER_BUILD', '1')

    try {
      expect(document.documentElement.dataset.hermesBrowser).toBeUndefined()
      expect(isBrowserShell()).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }

    expect(isBrowserShell()).toBe(false)
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

  it('does not start Bot Mode for regular users', () => {
    expect(isBundledPluginHidden('hermes-bots')).toBe(false)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(isBundledPluginHidden('hermes-bots')).toBe(true)
    expect(isBundledPluginHidden('kanban')).toBe(false)

    localStorage.setItem(DEVELOPER_MODE_KEY, 'true')

    expect(isBundledPluginHidden('hermes-bots')).toBe(false)
  })

  it('gives the page no app zoom: a fixed 90% and a setter that does nothing', async () => {
    expect(browserShellZoom()).toBeUndefined()

    document.documentElement.dataset.hermesBrowser = 'production'

    const zoom = browserShellZoom()!
    const listener = vi.fn()

    expect((await zoom.get()).percent).toBe(90)
    zoom.onChanged(listener)()
    zoom.setPercent(150)
    expect((await zoom.get()).percent).toBe(90)
    expect(listener).not.toHaveBeenCalled()
  })

  it('shows everything again in developer mode, but keeps what the browser build needs', () => {
    document.documentElement.dataset.hermesBrowser = 'production'

    expect(isDeveloperMode()).toBe(false)
    expect(hideForUsers()).toBe(true)

    localStorage.setItem(DEVELOPER_MODE_KEY, 'true')

    expect(isDeveloperMode()).toBe(true)
    expect(hideForUsers()).toBe(false)
    expect(isSettingsViewHidden('gateway')).toBe(false)
    expect(withoutHiddenNavItems([{ id: 'messaging' }]).map(item => item.id)).toEqual(['messaging'])
    expect(withoutHiddenPaletteItems([{ items: [{ id: 'cc-restart-gateway' }] }])).toHaveLength(1)
    expect(isBrowserShell()).toBe(true)

    // Switched off again, UniWork's store keeps the key as 'false'.
    localStorage.setItem(DEVELOPER_MODE_KEY, 'false')

    expect(hideForUsers()).toBe(true)
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

  it('runs HTML files from the instance as they are, in a frame without the app’s origin', () => {
    const html =
      '<!doctype html><title>贪吃蛇</title><button onclick="go()">开始</button><script>function go() {}</script>'

    const dataUrl = `data:text/html;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(html)))}`
    const staticCopy = vi.fn((_dataUrl: string) => '<p>static</p>')

    expect(remoteHtmlFrameDocument(dataUrl, staticCopy)).toBe('<p>static</p>')
    expect(staticCopy).toHaveBeenCalledWith(dataUrl)
    expect(remoteHtmlFrameSandbox()).toBe('')

    document.documentElement.dataset.hermesBrowser = 'production'
    staticCopy.mockClear()

    expect(remoteHtmlFrameDocument(dataUrl, staticCopy)).toBe(html)
    expect(staticCopy).not.toHaveBeenCalled()
    expect(remoteHtmlFrameDocument('data:text/plain;base64,aGk=', staticCopy)).toBeNull()
    expect(remoteHtmlFrameDocument('data:text/html;base64,%%%', staticCopy)).toBeNull()

    const sandbox = remoteHtmlFrameSandbox().split(' ')

    expect(sandbox).toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')
    expect(sandbox.filter(token => token.startsWith('allow-top-navigation'))).toEqual([])
    expect(remoteHtmlFrameSandbox()).toBe(HTML_PREVIEW_SANDBOX)
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

    localStorage.setItem(DEVELOPER_MODE_KEY, 'true')

    expect(visibleModelOptions(options)).toBe(options)
  })

  it('says installing from the skill market is in development, in the browser build only', () => {
    expect(skillMarketInstallPending('zh')).toBeNull()

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(skillMarketInstallPending('zh')).toBe('功能开发中')
    expect(skillMarketInstallPending('en')).toMatch(/in development/)
  })

  it('keeps a sidebar page that lands after the one gateway was activated again, in the browser build only', () => {
    expect(sidebarPageOutlivesReactivation()).toBe(false)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(sidebarPageOutlivesReactivation()).toBe(true)
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
