import { afterEach, describe, expect, it, vi } from 'vitest'

import sessionMenuSource from '@/app/chat/sidebar/session-actions-menu.tsx?raw'
import { setRuntimeI18nLocale } from '@/i18n/runtime'

import {
  browserInitialLocale,
  browserMediaPlaybackUrl,
  browserShellCopy,
  completionHint,
  effortShortLabels,
  findInPageTakenByViewer,
  hideForUsers,
  HTML_PREVIEW_SANDBOX,
  isBrowserShell,
  isBrowserTerminalPaste,
  isBundledPluginHidden,
  isConversationShareHidden,
  isDeveloperMode,
  isInstanceLocalUrl,
  isPlanUsageHidden,
  isSettingsViewHidden,
  isSlideDeck,
  newSessionTitle,
  officePreviewPdf,
  officeSheetBook,
  pdfDocumentSource,
  previewsOfficeAsPages,
  previewsOfficeAsPdf,
  previewsOfficeAsSheet,
  previewsPdfInViewer,
  remoteHtmlFrameDocument,
  remoteHtmlFrameSandbox,
  signOutDescription,
  skillMarketInstallPending,
  visibleModelOptions,
  withoutConversationShare,
  withoutDesktopPlugins,
  withoutHiddenNavItems,
  withoutHiddenPaletteItems,
  withoutHiddenSubpages
} from './browser-shell'

// The bridge fetches the PDF from the instance and says where media plays from (its own tests cover that).
const bridge = vi.hoisted(() => ({
  mediaPlaybackUrl: vi.fn((path: string) => `/__hermes_backend/api/fs/download?path=${encodeURIComponent(path)}`),
  officePreviewDataUrl: vi.fn(async () => 'data:application/pdf;base64,JVBERi0xLjc='),
  officeSheet: vi.fn(async () => ({
    images: ['source_html_1.png'],
    sheets: [{ html: '<table></table>', name: '客流统计', rows: 3, shown: 3 }],
    version: 'v7'
  })),
  officeSheetImageUrl: vi.fn((path: string, name: string, version: string) => `/charts/${name}?v=${version}`),
  pdfDocumentSource: vi.fn(async (path: string) => ({
    httpHeaders: {},
    url: `http://localhost/__hermes_backend/api/fs/download?path=${encodeURIComponent(path)}`,
    withCredentials: false
  }))
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
    expect(['gateway', 'connections', 'about', 'providers', 'vault'].map(isSettingsViewHidden)).toEqual([true, true, true, true, true])
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
      },
      { heading: 'navigate', items: [{ id: 'session-import' }] }
    ]

    expect(withoutHiddenPaletteItems(groups)).toBe(groups)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(withoutHiddenPaletteItems(groups)).toEqual([
      { heading: 'command center', items: [{ id: 'cc-reload-window' }] }
    ])
  })

  it('reads the rows the desktop labels in English in Chinese, developer mode or not', () => {
    const groups = [
      {
        heading: 'view',
        // As the palette keys contributed rows: `<source>:<id>`.
        items: [
          { detail: 'on', id: 'core:view.toggleStatusbar', label: 'Toggle status bar' },
          { id: 'core:profile.export', label: 'Export profile…' },
          { id: 'kanban:some.row', label: 'Plugin row' }
        ]
      }
    ]

    expect(withoutHiddenPaletteItems(groups)).toBe(groups)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(withoutHiddenPaletteItems(groups)[0].items).toEqual([
      { detail: '开', id: 'core:view.toggleStatusbar', label: '显示 / 隐藏状态栏' },
      { id: 'kanban:some.row', label: 'Plugin row' }
    ])

    localStorage.setItem(DEVELOPER_MODE_KEY, 'true')

    expect(withoutHiddenPaletteItems(groups)[0].items.map(item => item.label)).toEqual([
      '显示 / 隐藏状态栏',
      'Export profile…',
      'Plugin row'
    ])
  })

  it('names a new session, the effort levels and the backend’s `@` hints in Chinese', () => {
    const english = { high: 'High', low: 'Low' }

    expect(newSessionTitle('New session')).toBe('New session')
    expect(effortShortLabels(english)).toBe(english)
    expect(completionHint('attach file')).toBe('attach file')

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(newSessionTitle('New session')).toBe('新建会话')
    expect(effortShortLabels(english)).toMatchObject({ high: '高', low: '低', medium: '中' })
    expect(completionHint('attach file')).toBe('附加文件')
    expect(completionHint('a skill of mine')).toBe('a skill of mine')
    expect(completionHint(undefined)).toBeUndefined()
  })

  it('drops the messaging platforms and session import entries from the sidebar', () => {
    const nav = [
      { id: 'new-session' },
      { id: 'skills' },
      { id: 'messaging' },
      { id: 'session-import' },
      { id: 'artifacts' }
    ]

    expect(withoutHiddenNavItems(nav)).toBe(nav)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(withoutHiddenNavItems(nav).map(item => item.id)).toEqual(['new-session', 'skills', 'artifacts'])
  })

  it('does not start Bot Mode or kits and experts for regular users', () => {
    expect(isBundledPluginHidden('hermes-bots')).toBe(false)
    expect(isBundledPluginHidden('uniwork-kits')).toBe(false)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(isBundledPluginHidden('hermes-bots')).toBe(true)
    expect(isBundledPluginHidden('uniwork-kits')).toBe(true)
    expect(isBundledPluginHidden('kanban')).toBe(false)

    localStorage.setItem(DEVELOPER_MODE_KEY, 'true')

    expect(isBundledPluginHidden('hermes-bots')).toBe(false)
    expect(isBundledPluginHidden('uniwork-kits')).toBe(false)
  })

  it('filters sharing by availability and only exposes plans with a working browser bridge', () => {
    const items = [{ key: 'conversation-share', label: 'Share' }, { label: 'Rename' }]

    expect(isConversationShareHidden()).toBe(false)
    expect(withoutConversationShare(items)).toBe(items)
    expect(isPlanUsageHidden()).toBe(false)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(isConversationShareHidden()).toBe(true)
    expect(withoutConversationShare(items)).toEqual([{ label: 'Rename' }])
    expect(isPlanUsageHidden()).toBe(true)

    localStorage.setItem(DEVELOPER_MODE_KEY, 'true')

    expect(withoutConversationShare(items)).toBe(items)
    expect(isPlanUsageHidden()).toBe(true)
    const previous = window.hermesDesktop
    try {
      window.hermesDesktop = { getPlanUsage: vi.fn() } as never
      expect(isPlanUsageHidden()).toBe(false)
    } finally {
      window.hermesDesktop = previous
    }
    // The session menu marks its "share session" row with the key the filter drops.
    expect(sessionMenuSource).toContain("key: 'conversation-share'")
  })

  it('lists only the agent’s plugins for regular users, not the desktop ones', () => {
    const records = { kanban: { id: 'kanban' } }

    expect(withoutDesktopPlugins(records)).toBe(records)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(withoutDesktopPlugins(records)).toEqual({})
    // One object every time, so a memo over it does not recompute.
    expect(withoutDesktopPlugins(records)).toBe(withoutDesktopPlugins({ radio: { id: 'radio' } }))
  })

  it('drops the Advanced ▸ Desktop settings subpage', () => {
    const pages = [{ id: 'desktop' }, { id: 'runtime' }, { id: 'tools' }]

    expect(withoutHiddenSubpages('config:advanced', pages)).toBe(pages)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(withoutHiddenSubpages('config:advanced', pages).map(page => page.id)).toEqual(['runtime', 'tools'])
    expect(withoutHiddenSubpages('config:chat', [{ id: 'desktop' }])).toEqual([{ id: 'desktop' }])
  })

  it('drops the keyboard subpages of the desktop HUD window and of screen capture', () => {
    const pages = [{ id: 'shortcuts' }, { id: 'hud-gesture' }, { id: 'screen-capture' }]

    expect(withoutHiddenSubpages('keybinds', pages)).toBe(pages)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(withoutHiddenSubpages('keybinds', pages).map(page => page.id)).toEqual(['shortcuts'])
  })

  it('starts the interface in Chinese before the config answers', () => {
    expect(browserInitialLocale()).toBeUndefined()

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(browserInitialLocale()).toBe('zh-CN')
  })

  it('shows everything again in developer mode, but keeps what the browser build needs', () => {
    document.documentElement.dataset.hermesBrowser = 'production'

    expect(isDeveloperMode()).toBe(false)
    expect(hideForUsers()).toBe(true)

    localStorage.setItem(DEVELOPER_MODE_KEY, 'true')

    expect(isDeveloperMode()).toBe(true)
    expect(hideForUsers()).toBe(false)
    expect(isSettingsViewHidden('gateway')).toBe(false)
    expect(isSettingsViewHidden('providers')).toBe(false)
    expect(withoutHiddenNavItems([{ id: 'messaging' }]).map(item => item.id)).toEqual(['messaging'])
    expect(withoutHiddenPaletteItems([{ items: [{ id: 'cc-restart-gateway' }] }])).toHaveLength(1)
    expect(withoutHiddenSubpages('config:advanced', [{ id: 'desktop' }])).toHaveLength(1)
    expect(withoutDesktopPlugins({ kanban: {} })).toEqual({ kanban: {} })
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

  it('only allows browser market installation with a persistence-aware bridge', () => {
    expect(skillMarketInstallPending('zh')).toBeNull()

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(skillMarketInstallPending('zh')).toBe('功能开发中')
    expect(skillMarketInstallPending('en')).toMatch(/in development/)
    const previous = window.hermesDesktop
    try {
      window.hermesDesktop = { cloudSkillOperations: { mutate: vi.fn() } } as never
      expect(skillMarketInstallPending('zh')).toBeNull()
    } finally {window.hermesDesktop = previous}
  })

  it('says signing out keeps the instance, in the browser build only', () => {
    expect(signOutDescription('zh')).toBeNull()

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(signOutDescription('zh')).toBe('退出后回到登录页。对话、文件和定时任务都会保留。')
    expect(signOutDescription('en')).toMatch(/sign-in page/)
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

  it('opens slide decks and documents in the page viewer, in the browser build only', () => {
    expect(previewsOfficeAsPages('/w/deck.pptx')).toBe(false)
    expect(previewsOfficeAsPages('/w/报告.docx')).toBe(false)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(
      ['/w/a.pptx', '/w/b.PPT', '/w/c.odp', '/w/d.docx', '/w/e.DOC', '/w/f.odt'].map(previewsOfficeAsPages)
    ).toEqual([true, true, true, true, true, true])
    expect(['/w/a.xlsx', '/w/b.pdf', '/w/c.pptx.md', '/w/d.docm'].map(previewsOfficeAsPages)).toEqual([
      false,
      false,
      false,
      false
    ])
    // Only decks are presented full screen.
    expect(['/w/a.pptx', '/w/b.odp', '/w/c.docx', '/w/d.odt'].map(isSlideDeck)).toEqual([true, true, false, false])
    expect(browserShellCopy('zh').slides.counter(2, 5)).toBe('2 / 5')
    expect(browserShellCopy('zh').slides.page(3)).toBe('第 3 页')
    expect(browserShellCopy('en').slides.documentPage(3)).toBe('Page 3')
  })

  it('opens spreadsheets in the sheet viewer, in the browser build only', async () => {
    expect(previewsOfficeAsSheet('/w/城市客流统计.xlsx')).toBe(false)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(['/w/a.xlsx', '/w/b.XLS', '/w/c.ods'].map(previewsOfficeAsSheet)).toEqual([true, true, true])
    expect(['/w/a.csv', '/w/b.docx', '/w/c.pptx', '/w/d.xlsx.md', '/w/e.xlsm'].map(previewsOfficeAsSheet)).toEqual([
      false,
      false,
      false,
      false,
      false
    ])

    const book = await officeSheetBook('/w/城市客流统计.xlsx')

    expect(bridge.officeSheet).toHaveBeenCalledWith('/w/城市客流统计.xlsx')
    expect(book.sheets.map(sheet => sheet.name)).toEqual(['客流统计'])
    // Pictures only by the names the instance listed.
    expect(book.imageUrl('source_html_1.png')).toBe('/charts/source_html_1.png?v=v7')
    expect(book.imageUrl('../../etc/passwd')).toBeNull()
    expect(browserShellCopy('zh').sheet.truncated(1000, 20001)).toBe(
      '只显示前 1000 行（共 20001 行），完整内容请下载后查看。'
    )
    expect(browserShellCopy('en').sheet.unnamed(2)).toBe('Sheet 2')
  })

  it('opens PDFs in the PDF viewer, in the browser build only', async () => {
    const viewer = document.createElement('div')
    const pages = document.createElement('div')

    viewer.dataset.pdfViewer = ''
    pages.tabIndex = 0
    viewer.append(pages)
    document.body.append(viewer)
    pages.focus()

    expect(previewsPdfInViewer('/w/论文.pdf')).toBe(false)
    expect(findInPageTakenByViewer()).toBe(true)

    document.documentElement.dataset.hermesBrowser = 'production'

    expect(['/w/a.pdf', '/w/b.PDF'].map(previewsPdfInViewer)).toEqual([true, true])
    expect(['/w/a.pdf.md', '/w/b.docx', '/w/c.pdfx', '/w/d.png'].map(previewsPdfInViewer)).toEqual([
      false,
      false,
      false,
      false
    ])
    // ⌘F searches the PDF while the viewer has focus, the chat otherwise.
    expect(findInPageTakenByViewer()).toBe(true)
    pages.blur()
    expect(findInPageTakenByViewer()).toBe(false)
    viewer.remove()

    await expect(pdfDocumentSource('/w/论文.pdf')).resolves.toMatchObject({
      url: `http://localhost/__hermes_backend/api/fs/download?path=${encodeURIComponent('/w/论文.pdf')}`
    })
    expect(bridge.pdfDocumentSource).toHaveBeenCalledWith('/w/论文.pdf')
    expect(browserShellCopy('zh').pdf.findNone).toBe('无结果')
    expect(browserShellCopy('en').pdf.fitWidth).toBe('Fit to width')
  })

  it('plays audio and video from the instance, in the browser build only', async () => {
    expect(browserMediaPlaybackUrl('/w/clip.mp4')).toBeNull()

    document.documentElement.dataset.hermesBrowser = 'production'

    await expect(browserMediaPlaybackUrl('/w/小狗视频.mp4')).resolves.toBe(
      `/__hermes_backend/api/fs/download?path=${encodeURIComponent('/w/小狗视频.mp4')}`
    )
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
