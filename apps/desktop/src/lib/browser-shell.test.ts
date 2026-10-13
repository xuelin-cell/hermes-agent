import { afterEach, describe, expect, it, vi } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n/runtime'

import {
  browserMediaPlaybackUrl,
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
  officePreviewPdf,
  previewsMediaInPanel,
  previewsOfficeAsPdf,
  previewsOfficeAsSlides,
  remoteHtmlFrameDocument,
  remoteHtmlFrameSandbox,
  sidebarPageOutlivesReactivation,
  skillMarketInstallPending,
  visibleModelOptions,
  withoutHiddenNavItems,
  withoutHiddenPaletteItems
} from './browser-shell'
import { mediaKind } from './media'

// The bridge fetches the PDF from the instance and says where media plays from (its own tests cover that).
const bridge = vi.hoisted(() => ({
  mediaPlaybackUrl: vi.fn((path: string) => `/__hermes_backend/api/fs/download?path=${encodeURIComponent(path)}`),
  officePreviewDataUrl: vi.fn(async () => 'data:application/pdf;base64,JVBERi0xLjc=')
}))

vi.mock('@/dev/browser-bridge', () => bridge)

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

  it('previews Office files as the PDF the instance makes of them, in the browser build only', async () => {
    expect(previewsOfficeAsPdf('/w/deck.pptx')).toBe(false)
    expect(officePreviewPdf('/w/deck.pptx')).toBeNull()

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(['/w/a.pptx', '/w/b.DOCX', '/w/c.xls', '/w/d.odp', '/w/e.ppt', '/w/f.doc'].map(previewsOfficeAsPdf)).toEqual(
      [true, true, true, true, true, true]
    )
    expect(['/w/a.pdf', '/w/notes.txt', '/w/pptx', '/w/a.pptx.md', '/w/a.docm'].map(previewsOfficeAsPdf)).toEqual([
      false,
      false,
      false,
      false,
      false
    ])
    expect(officePreviewPdf('/w/notes.md')).toBeNull()
    await expect(officePreviewPdf('/w/新疆文旅.pptx')).resolves.toBe('data:application/pdf;base64,JVBERi0xLjc=')
    expect(bridge.officePreviewDataUrl).toHaveBeenCalledWith('/w/新疆文旅.pptx')

    setRuntimeI18nLocale('zh')

    expect(browserShellCopy().officePreview.too_large).toBe('文件太大，不能在线预览，请下载后查看。')
    expect(browserShellCopy('en').officePreview.convert_failed).toMatch(/Download it instead/)
  })

  it('opens slide decks in the slide viewer, in the browser build only', () => {
    expect(previewsOfficeAsSlides('/w/deck.pptx')).toBe(false)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(['/w/a.pptx', '/w/b.PPT', '/w/c.odp'].map(previewsOfficeAsSlides)).toEqual([true, true, true])
    expect(['/w/a.docx', '/w/b.xlsx', '/w/c.pdf', '/w/d.pptx.md'].map(previewsOfficeAsSlides)).toEqual([
      false,
      false,
      false,
      false
    ])
    expect(browserShellCopy('zh').slides.counter(2, 5)).toBe('2 / 5')
    expect(browserShellCopy('zh').slides.page(3)).toBe('第 3 页')
  })

  it('plays audio and video from the instance, in the browser build only', async () => {
    expect(browserMediaPlaybackUrl('/w/clip.mp4')).toBeNull()
    expect(previewsMediaInPanel('/w/clip.mp4')).toBe(false)

    document.documentElement.dataset.hermesBrowser = 'production'

    await expect(browserMediaPlaybackUrl('/w/小狗视频.mp4')).resolves.toBe(
      `/__hermes_backend/api/fs/download?path=${encodeURIComponent('/w/小狗视频.mp4')}`
    )
    expect(['/w/a.mp4', '/w/b.MP3', '/w/c.webm', '/w/d.wav', '/w/e.m4a'].map(previewsMediaInPanel)).toEqual([
      true,
      true,
      true,
      true,
      true
    ])
    expect(['/w/a.png', '/w/b.pdf', '/w/c.pptx', '/w/d.mp4.md', '/w/e.txt'].map(previewsMediaInPanel)).toEqual([
      false,
      false,
      false,
      false,
      false
    ])

    // The pane plays the same files as the chat's players (lib/media.ts).
    for (const ext of 'aac avi flac gif m4a m4v mkv mov mp3 mp4 ogg opus wav webm'.split(' ')) {
      expect(previewsMediaInPanel(`/w/x.${ext}`), ext).toBe(['audio', 'video'].includes(mediaKind(`/w/x.${ext}`)))
    }

    expect(browserShellCopy('zh').media.failed).toBe('浏览器放不了这个文件，请下载后查看。')
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
