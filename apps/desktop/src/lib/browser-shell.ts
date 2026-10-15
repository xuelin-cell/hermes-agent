import { getRuntimeI18nLocale } from '@/i18n/runtime'
import { storedBoolean } from '@/lib/storage'

/**
 * The browser build: the renderer runs in an ordinary browser tab (the cloud,
 * multi-tenant deployment) and `src/dev/browser-bridge.ts` stands in for
 * Electron's preload. The bridge marks the document (`data-hermes-browser`)
 * before the app mounts.
 *
 * Every upstream file that behaves differently in the browser build asks this
 * module, and nothing else, so the complete list of such places is below. Keep
 * each call site to a single condition so upstream merges stay trivial; after a
 * merge, `grep -rn "browser-shell'" src` must still find every entry.
 *
 * Two kinds of difference. Places marked * only hide what regular users have no
 * use for and go through `hideForUsers()`, so developer mode shows them again,
 * working or not. The rest are what the browser build has to do differently,
 * developer mode or not. Files of the UniWork rebrand (not upstream) that ask
 * this module are listed too.
 *
 *   api/models.ts                                      * model pickers: the platform's providers only
 *   app/artifacts/cloud-drive-tab.tsx                  the personal cloud drive tab says it is in development
 *   app/artifacts/index.tsx                            the library opens on local artifacts
 *   app/capabilities/plugins/plugins-tab.tsx           * no desktop (local) plugins, no "open plugins folder"
 *   app/capabilities/skill-market.tsx                  installing from the market says it is in development
 *   app/chat/right-rail/media-preview.tsx              (ours) the player for audio and video files
 *   app/chat/right-rail/office-sheet.tsx               (ours) the sheet viewer: spreadsheets the instance turns into tables
 *   app/chat/right-rail/office-slides.tsx              (ours) the page viewer: decks and documents the instance renders page by page
 *   app/chat/right-rail/pdf-preview.tsx                (ours) the PDF viewer: pdf.js in the page, in the page viewer's look
 *   app/chat/right-rail/preview-file.tsx               Office files fall back to the PDF the instance converts them to
 *   app/chat/right-rail/preview-pane.tsx               HTML files from the instance run their scripts, sandboxed;
 *                                                      slide decks and documents open in the page viewer, spreadsheets in
 *                                                      the sheet viewer, PDFs in the PDF viewer, audio and video in the
 *                                                      player
 *   app/chat/sidebar/filter-menu.tsx                   * no profile submenu (filter / new / import)
 *   app/chat/sidebar/index.tsx                         * no messaging platforms or session import entry
 *   app/chat/sidebar/profile-switcher.tsx              * no add / import profile, no "connect gateway"
 *   app/command-palette/index.tsx                      * no in-app browser, Hermes update, theme marketplace, gateway
 *                                                      restart, session import
 *   app/hooks/use-keybinds.ts                          ⌘F / Ctrl+F in the PDF viewer searches the PDF, not the chat
 *   app/profiles/index.tsx                             * no "new profile"
 *   app/right-sidebar/file-actions.tsx                 rename + delete (to the instance's recycle bin) in the menu
 *   app/right-sidebar/terminal/use-terminal-session.ts Ctrl+V / Ctrl+Shift+V paste through the browser
 *   app/settings/appearance-settings.tsx               * no theme marketplace results, no UI scale row
 *   app/settings/config-settings.tsx                   * no Advanced ▸ Desktop settings (keep awake, F12, backend pool,
 *                                                      Quick Entry)
 *   app/settings/index.tsx                             * no Gateway, Credential Vault or About page
 *   app/settings/subpages.ts                           * no Advanced ▸ Desktop subpage
 *   app/shell/gateway-menu-panel.tsx                   * no gateway restart
 *   contrib/plugins.ts                                 * no Bot Mode (the BOTS tab): its plugin is not started
 *   lib/local-preview.ts                               Office files (pptx, docx, xlsx …) are previews, never read as text
 *   lib/media.ts                                       audio and video in the chat play straight from the instance
 *   lib/model-options.ts                               * model pickers: the platform's providers only
 *   store/developer-mode.ts                            flipping UniWork's developer mode reloads the page
 *   store/preview.ts                                   no in-app browser: links and URL previews open in a new tab
 *   store/profile.ts                                   only the default profile
 *
 * The bridge itself is loaded by one line of `main.tsx` (`import
 * './dev/browser-bridge'`), a no-op in Electron, where the preload has already
 * installed the real one. The desktop app does not need that line, so a merge
 * may drop it: without it the browser build has no bridge at all.
 *
 * The terminal panel, rename and the recycle bin need no page changes: the
 * bridge implements them against the instance (`/__mt_user/…` behind the
 * entry), see `browser-bridge.ts`. Nor do the masked keys on the MCP page: the
 * bridge masks what the page reads and puts the keys back in what it saves, see
 * `dev/mcp-secrets.ts`. Preload methods the bridge leaves out are fine as long
 * as the page calls them optionally (`?.()`) or checks for them first, as it does
 * for every desktop-only feature (screenshots, tray, pool limits, MaaS account …).
 *
 * Two build-time hooks in vite.config.ts: it emits the files pdf.js loads by
 * name (its worker, CMaps, fonts, decoders) for the PDF viewer, see
 * `scripts/pdfjs-assets.mjs`; and the browser build has no `login.html` page
 * (the entry signs users in, not the desktop's login window).
 */
export function isBrowserShell(): boolean {
  // The production browser build is known at build time. The bridge's mark
  // alone is not enough there: a module that asks while loading, in a chunk the
  // bundle evaluates before the bridge, would not see it yet.
  return (
    import.meta.env.VITE_HERMES_BROWSER_BUILD === '1' ||
    (typeof document !== 'undefined' && Boolean(document.documentElement?.dataset?.hermesBrowser))
  )
}

// UniWork's own developer mode, the key of store/developer-mode.ts.
const DEVELOPER_MODE_KEY = 'uniwork.desktop.developerMode.v1'

/** Developer mode, per browser: UniWork's switch, tapping the title (元景数字员工)
 * 5 times (app/shell/titlebar-controls.tsx). */
export function isDeveloperMode(): boolean {
  return storedBoolean(DEVELOPER_MODE_KEY, false)
}

/** Developer mode was just flipped. What regular users see is decided while
 * rendering and at startup (Bot Mode is not even started), so the browser build
 * starts over rather than show a mix of both. */
export function reloadAfterDeveloperModeToggle(): void {
  if (isBrowserShell()) {
    window.location.reload()
  }
}

/** Hide something regular users of the browser build have no use for: desktop-only
 * features, providers outside the platform's plan. Developer mode shows it again. */
export function hideForUsers(): boolean {
  return isBrowserShell() && !isDeveloperMode()
}

interface PickerProvider {
  is_current?: boolean | null
  is_user_defined?: boolean | null
}

/** Model pickers list the providers the platform configures (the `providers:`
 * block of the instance's config, `is_user_defined`) and whichever one is in use.
 * Hermes' built-in providers — keyless free ones, or one the user pasted a key
 * for — show up in developer mode. */
export function visibleModelOptions<T extends { providers?: PickerProvider[] }>(options: T): T {
  if (!hideForUsers() || !Array.isArray(options?.providers)) {
    return options
  }

  return { ...options, providers: options.providers.filter(p => p.is_user_defined || p.is_current) }
}

/** Paste chords in the terminal: Ctrl+V and Ctrl+Shift+V (⌘V on macOS). The
 * desktop app takes Ctrl+Shift+V and reads the clipboard itself, and plain
 * Ctrl+V goes to the shell as ^V. A page can't read the clipboard (no clipboard
 * API on plain http, a permission prompt on https), and Ctrl+V is what browser
 * users press, so both chords are left to the browser's own paste, which xterm
 * picks up. */
export function isBrowserTerminalPaste(event: KeyboardEvent): boolean {
  if (!isBrowserShell() || event.type !== 'keydown' || event.altKey || event.key.toLowerCase() !== 'v') {
    return false
  }

  const mac = /mac/i.test(globalThis.navigator?.platform ?? '')

  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

/** Sandbox for agent-written HTML, in the preview pane and in a new tab
 * (`browser-bridge.ts`). Never `allow-same-origin`: its scripts run in an opaque
 * origin, with no access to the app, its storage or its cookies, and it cannot
 * navigate the app away. */
export const HTML_PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox'

const HTML_DATA_URL_PREFIX = 'data:text/html;base64,'

/** The preview pane's document for an HTML file in the instance. The desktop
 * app, on a remote gateway, shows a static copy with the scripts stripped
 * (`staticCopy`). The browser build shows the file as it is, so games, charts
 * and other pages that need their scripts work, isolated by
 * `remoteHtmlFrameSandbox()` the same way as when opened in a new tab. */
export function remoteHtmlFrameDocument(
  dataUrl: string,
  staticCopy: (dataUrl: string) => null | string
): null | string {
  if (!isBrowserShell()) {
    return staticCopy(dataUrl)
  }

  if (!dataUrl.startsWith(HTML_DATA_URL_PREFIX)) {
    return null
  }

  try {
    const bytes = Uint8Array.from(atob(dataUrl.slice(HTML_DATA_URL_PREFIX.length)), char => char.charCodeAt(0))

    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/** The pane's frame sandbox for those files: the desktop app's static copy runs
 * nothing (`''`). */
export function remoteHtmlFrameSandbox(): string {
  return isBrowserShell() ? HTML_PREVIEW_SANDBOX : ''
}

const OFFICE_FILE_RE = /\.(?:docx?|pptx?|xlsx?|od[pst])$/i

/** Office files (Word, PowerPoint, Excel and their OpenDocument kin) in the
 * browser build. The preview pane has no Office viewer: upstream reads them as
 * binary, and "preview anyway" shows the zip bytes as text. The instance turns
 * them into a PDF with LibreOffice and the pane shows that PDF. */
export function previewsOfficeAsPdf(path: string): boolean {
  return isBrowserShell() && OFFICE_FILE_RE.test(path)
}

/** The preview pane's bytes for an Office file: the PDF the instance makes of
 * it, as a `data:application/pdf` URL. Null for every other file, which the pane
 * reads as usual. */
export function officePreviewPdf(path: string): null | Promise<string> {
  return previewsOfficeAsPdf(path)
    ? import('@/dev/browser-bridge').then(bridge => bridge.officePreviewDataUrl(path))
    : null
}

const SLIDE_DECK_RE = /\.(?:pptx?|odp)$/i
const DOCUMENT_RE = /\.(?:docx?|odt)$/i
const SPREADSHEET_RE = /\.(?:xlsx?|ods)$/i

/** Slide decks (PowerPoint, Impress) and documents (Word, Writer) in the browser
 * build open in the page viewer (app/chat/right-rail/office-slides.tsx) rather
 * than the browser's PDF viewer: the pages scroll top to bottom, as images the
 * instance renders. */
export function previewsOfficeAsPages(path: string): boolean {
  return isBrowserShell() && (SLIDE_DECK_RE.test(path) || DOCUMENT_RE.test(path))
}

/** A slide deck, not a document: the page viewer presents decks full screen. */
export function isSlideDeck(path: string): boolean {
  return SLIDE_DECK_RE.test(path)
}

/** Spreadsheets (Excel, Calc) in the browser build open in the sheet viewer
 * (app/chat/right-rail/office-sheet.tsx): a table per sheet as LibreOffice
 * exports it, formulas worked out, number formats, merged cells and charts kept.
 * Printed to PDF, a wide table is cut across pages. */
export function previewsOfficeAsSheet(path: string): boolean {
  return isBrowserShell() && SPREADSHEET_RE.test(path)
}

const PDF_RE = /\.pdf$/i

/** PDFs in the browser build open in the PDF viewer
 * (app/chat/right-rail/pdf-preview.tsx): pdf.js in the page, laid out like the
 * page viewer, its text selectable and searchable. Upstream reads the whole file
 * as a data URL (16 MB at most) and frames the browser's own PDF viewer. */
export function previewsPdfInViewer(path: string): boolean {
  return isBrowserShell() && PDF_RE.test(path)
}

/** ⌘F / Ctrl+F while the PDF viewer has focus opens the viewer's own search,
 * which searches the whole PDF, rather than the app's find bar over the chat. */
export function findInPageTakenByViewer(): boolean {
  return isBrowserShell() && document.activeElement?.closest('[data-pdf-viewer]') != null
}

/** What pdf.js reads a PDF from: its bytes, or where to fetch it. */
export type PdfDocumentSource =
  { data: Uint8Array } | { httpHeaders: Record<string, string>; url: string; withCredentials: boolean }

/** Loads the bridge only when a PDF is opened, as officeSlideDeck does. */
export async function pdfDocumentSource(path: string): Promise<PdfDocumentSource> {
  return (await import('@/dev/browser-bridge')).pdfDocumentSource(path)
}

/** A deck as the slide viewer shows it: page count, page size in points, and
 * where each page's image is (it changes when the file does). */
export interface OfficeSlideDeck {
  height: number
  imageUrl: (page: number) => string
  pages: number
  width: number
}

/** The bridge is loaded only when a deck is opened: importing it installs the
 * browser bridge, which nothing outside the browser build should do. */
export async function officeSlideDeck(path: string): Promise<OfficeSlideDeck> {
  const bridge = await import('@/dev/browser-bridge')
  const info = await bridge.officeSlidesInfo(path)

  return {
    height: info.height,
    imageUrl: (page: number) => bridge.officeSlideImageUrl(path, page, info.version),
    pages: info.pages,
    width: info.width
  }
}

/** A spreadsheet as the sheet viewer shows it: each sheet's table (HTML, still to
 * be sanitized), how many rows the sheet has and how many came along, and where a
 * chart picture in a table is (null for a name the instance did not list). */
export interface OfficeSheetBook {
  imageUrl: (name: string) => null | string
  sheets: { html: string; name: string; rows: number; shown: number }[]
}

/** Loads the bridge only when a spreadsheet is opened, as officeSlideDeck does. */
export async function officeSheetBook(path: string): Promise<OfficeSheetBook> {
  const bridge = await import('@/dev/browser-bridge')
  const book = await bridge.officeSheet(path)
  const images = new Set(book.images)

  return {
    imageUrl: (name: string) => (images.has(name) ? bridge.officeSheetImageUrl(path, name, book.version) : null),
    sheets: book.sheets
  }
}

/** Where audio and video from the instance play from in the browser build: the
 * instance's download route, which answers Range requests, so playback starts
 * early and the player can seek. The desktop shell streams through its own
 * hermes-media:// protocol, which a browser cannot load: the chat's players
 * stayed black. Null outside the browser build. */
export function browserMediaPlaybackUrl(path: string): null | Promise<string> {
  return isBrowserShell() ? import('@/dev/browser-bridge').then(bridge => bridge.mediaPlaybackUrl(path)) : null
}

// The audio and video extensions of lib/media.ts (which imports this module).
const PLAYABLE_MEDIA_RE = /\.(?:avi|flac|m4a|mkv|mov|mp3|mp4|ogg|opus|wav|webm)$/i

/** Audio and video files open in the preview pane's player
 * (app/chat/right-rail/media-preview.tsx). Upstream reads them as binary and
 * offers to show the bytes as text. */
export function previewsMediaInPanel(path: string): boolean {
  return isBrowserShell() && PLAYABLE_MEDIA_RE.test(path)
}

const INSTANCE_LOCAL_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$/i

/** A web address on the agent's own machine (a dev server it started, …). In
 * the browser build that machine is the cloud instance, whose ports the browser
 * cannot reach — opening it would show the user's own computer instead. */
export function isInstanceLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)

    return /^https?:$/i.test(parsed.protocol) && INSTANCE_LOCAL_HOST_RE.test(parsed.hostname)
  } catch {
    return false
  }
}

const SETTINGS_VIEWS_HIDDEN = new Set(['about', 'connections', 'gateway', 'vault'])

/** Settings pages that only make sense for the desktop app: gateway / SSH
 * connections (`connections` is the old link to the gateway page), About (app
 * version, self-update, uninstall), and the Credential Vault: it keeps logins in
 * the instance's home, which is not on the user's volume and does not survive
 * the instance being replaced. */
export function isSettingsViewHidden(view: string): boolean {
  return hideForUsers() && SETTINGS_VIEWS_HIDDEN.has(view)
}

const PALETTE_ITEMS_HIDDEN = new Set([
  'cc-open-browser',
  'cc-restart-gateway',
  'cc-update-hermes',
  'session-import',
  'theme-install'
])

/** Command-palette rows for desktop-only features: the in-app browser, updating
 * Hermes from the app (the cloud upgrades instances itself), the theme
 * marketplace, restarting the messaging gateway (an instance runs none), and
 * session import (see the sidebar below). Empty groups go too. */
export function withoutHiddenPaletteItems<G extends { items: readonly { id: string }[] }>(groups: G[]): G[] {
  if (!hideForUsers()) {
    return groups
  }

  return groups
    .map(group => ({ ...group, items: group.items.filter(item => !PALETTE_ITEMS_HIDDEN.has(item.id)) }) as G)
    .filter(group => group.items.length > 0)
}

const SIDEBAR_NAV_HIDDEN = new Set(['messaging', 'session-import'])

/** Sidebar entries for desktop-only features: messaging platforms need an
 * always-on gateway with a public address, which a cloud instance (paused when
 * idle) does not have; session import reads other agents' session folders on
 * the backend's machine, and an instance has none. */
export function withoutHiddenNavItems<T extends { id: string }>(items: T[]): T[] {
  return hideForUsers() ? items.filter(item => !SIDEBAR_NAV_HIDDEN.has(item.id)) : items
}

const BUNDLED_PLUGINS_HIDDEN = new Set(['hermes-bots'])

/** Bundled plugins that are not started for regular users. Bot Mode (the
 * SESSIONS | BOTS tabs, Routines, @bot mentions) is one agent per profile, and
 * the browser build has only the default profile. */
export function isBundledPluginHidden(id: string): boolean {
  return hideForUsers() && BUNDLED_PLUGINS_HIDDEN.has(id)
}

const NO_DESKTOP_PLUGINS = {}

/** Capabilities ▸ Plugins without its desktop half: desktop plugins live in the
 * app's plugins folder on the user's own computer, so regular users see the
 * agent's plugins only. One object, so the page's memo keeps its input. */
export function withoutDesktopPlugins<T extends object>(records: T): T {
  return hideForUsers() ? (NO_DESKTOP_PLUGINS as T) : records
}

const SETTINGS_SUBPAGES_HIDDEN = new Set(['config:advanced/desktop'])

/** Settings subpages of this-computer-only knobs: Advanced ▸ Desktop (keep the
 * machine awake, F12, the backend pool, Quick Entry's global shortcut, app
 * updates). The browser has none of them. */
export function withoutHiddenSubpages<P extends { id: string }>(view: string, pages: readonly P[]): readonly P[] {
  return hideForUsers() ? pages.filter(page => !SETTINGS_SUBPAGES_HIDDEN.has(`${view}/${page.id}`)) : pages
}

/** Codes the instance's file endpoints answer with (`deploy/hermes-mt/seed/mtuser.py`). */
export type InstanceFileErrorCode = 'exists' | 'invalid_name' | 'not_found' | 'outside' | 'protected'

/** Why the instance could not make a PDF of an Office file (same module), plus
 * `failed` for anything else. */
export type OfficePreviewErrorCode =
  'convert_failed' | 'failed' | 'not_found' | 'outside' | 'timeout' | 'too_large' | 'unavailable' | 'unsupported'

interface BrowserShellCopy {
  agentOpenedLink: (host: string) => string
  deleteBody: (isDirectory: boolean) => string
  deleteConfirm: string
  fileErrors: Record<InstanceFileErrorCode, string>
  instanceLocalUrl: (host: string) => string
  instanceOutdated: string
  mcpKeyStale: string
  media: {
    failed: string
    loading: string
  }
  movedToTrash: (name: string) => string
  officePreview: Record<OfficePreviewErrorCode, string>
  open: string
  pdf: {
    failed: string
    find: string
    findClose: string
    findNext: string
    findNone: string
    findPrevious: string
    fitWidth: string
    invalid: string
    loading: string
    password: string
    passwordIncorrect: string
    passwordLabel: string
    passwordOpen: string
    zoomIn: string
    zoomOut: string
  }
  popupBlocked: string
  previewTitle: string
  previewTooLarge: string
  restoreFailed: string
  sheet: {
    empty: string
    sheets: string
    truncated: (shown: number, rows: number) => string
    unnamed: (index: number) => string
  }
  skillInstallPending: string
  slides: {
    counter: (page: number, pages: number) => string
    documentPage: (page: number) => string
    exitFullscreen: string
    fullscreen: string
    next: string
    page: (page: number) => string
    preparing: string
    previous: string
  }
  terminalDisconnected: string
  terminalUnavailable: string
  undo: string
}

const COPY: Record<'en' | 'zh', BrowserShellCopy> = {
  en: {
    agentOpenedLink: (host: string) => `The agent wants to open ${host}.`,
    deleteBody: (isDirectory: boolean) =>
      isDirectory
        ? 'The folder and everything in it move to the recycle bin. You can undo this for 7 days.'
        : 'The file moves to the recycle bin. You can undo this for 7 days.',
    deleteConfirm: 'Delete',
    fileErrors: {
      exists: 'A file or folder with that name already exists.',
      invalid_name: 'That name is not allowed.',
      not_found: 'The file is no longer there.',
      outside: 'Only files in the workspace can be changed.',
      protected: 'This folder holds chat attachments and generated images. It cannot be deleted or renamed.'
    },
    instanceLocalUrl: (host: string) =>
      `${host} is a web service inside your cloud instance. The browser version cannot open it yet.`,
    instanceOutdated: 'Your instance is being upgraded. Reload the page and try again.',
    mcpKeyStale: 'A masked key on this page is out of date. Reload the page and save again.',
    media: {
      failed: 'This file does not play in the browser. Download it instead.',
      loading: 'Loading…'
    },
    movedToTrash: (name: string) => `Moved “${name}” to the recycle bin.`,
    officePreview: {
      convert_failed:
        'This file could not be turned into a preview. It may be damaged or in a format that is not supported. Download it instead.',
      failed: 'Could not make a preview of this file. Download it instead.',
      not_found: 'The file is no longer there.',
      outside: 'Only files in the workspace can be previewed. Download it instead.',
      timeout: 'Making the preview took too long. Try again later, or download the file.',
      too_large: 'This file is too large to preview. Download it instead.',
      unavailable: 'Your instance cannot make previews right now. Download the file instead.',
      unsupported: 'Files of this kind cannot be previewed. Download it instead.'
    },
    open: 'Open',
    pdf: {
      failed: 'Could not open this PDF. Download it instead.',
      find: 'Find in document',
      findClose: 'Close search',
      findNext: 'Next match',
      findNone: 'No matches',
      findPrevious: 'Previous match',
      fitWidth: 'Fit to width',
      invalid: 'This file is damaged or is not a PDF. Download it instead.',
      loading: 'Opening the PDF…',
      password: 'This PDF is protected by a password.',
      passwordIncorrect: 'Wrong password. Try again.',
      passwordLabel: 'Password',
      passwordOpen: 'Open',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out'
    },
    popupBlocked: 'The browser blocked the new tab. Allow pop-ups for this site and try again.',
    previewTitle: 'Preview',
    previewTooLarge: 'This file is too large to open in a tab. Download it instead.',
    restoreFailed: 'Could not restore the file',
    sheet: {
      empty: 'This spreadsheet has nothing to show.',
      sheets: 'Sheets',
      truncated: (shown: number, rows: number) =>
        `Showing the first ${shown} of ${rows} rows. Download the file to see them all.`,
      unnamed: (index: number) => `Sheet ${index}`
    },
    skillInstallPending: 'Installing from here is in development.',
    slides: {
      counter: (page: number, pages: number) => `${page} / ${pages}`,
      documentPage: (page: number) => `Page ${page}`,
      exitFullscreen: 'Exit full screen',
      fullscreen: 'Present full screen',
      next: 'Next slide',
      page: (page: number) => `Slide ${page}`,
      preparing: 'Preparing the preview…',
      previous: 'Previous slide'
    },
    terminalDisconnected: 'Disconnected from the instance. Close this tab and open a new terminal.',
    terminalUnavailable: 'Could not reach the shell in your instance. Try again shortly (at most 8 terminals at once).',
    undo: 'Undo'
  },
  zh: {
    agentOpenedLink: (host: string) => `agent 想打开 ${host}。`,
    deleteBody: (isDirectory: boolean) =>
      isDirectory ? '这个文件夹及其中所有文件将移到回收站，7 天内可以撤销。' : '将移到回收站，7 天内可以撤销。',
    deleteConfirm: '删除',
    fileErrors: {
      exists: '已经有同名的文件或文件夹。',
      invalid_name: '这个名字不能用。',
      not_found: '文件已经不在了。',
      outside: '只能操作工作区里的文件。',
      protected: '这个文件夹存放聊天附件和生成的图片，不能删除或改名。'
    },
    instanceLocalUrl: (host: string) => `这是实例里的网页服务（${host}），浏览器版暂时打不开。`,
    instanceOutdated: '实例正在升级，请刷新页面后再试。',
    mcpKeyStale: '页面上打了码的 key 已经过期，请刷新页面后再保存。',
    media: {
      failed: '浏览器放不了这个文件，请下载后查看。',
      loading: '正在加载…'
    },
    movedToTrash: (name: string) => `已把「${name}」移到回收站。`,
    officePreview: {
      convert_failed: '这个文件转不成预览，可能已损坏或格式不受支持，请下载后查看。',
      failed: '生成预览失败，请下载后查看。',
      not_found: '文件已经不在了。',
      outside: '只能预览工作区里的文件，请下载后查看。',
      timeout: '生成预览超时，请稍后再试，或下载后查看。',
      too_large: '文件太大，不能在线预览，请下载后查看。',
      unavailable: '实例暂时不能生成预览，请下载后查看。',
      unsupported: '这种文件不能在线预览，请下载后查看。'
    },
    open: '打开',
    pdf: {
      failed: '打不开这个 PDF，请下载后查看。',
      find: '在文档中查找',
      findClose: '关闭查找',
      findNext: '下一个',
      findNone: '无结果',
      findPrevious: '上一个',
      fitWidth: '适合宽度',
      invalid: '文件已损坏或不是 PDF，请下载后查看。',
      loading: '正在打开 PDF…',
      password: '这个 PDF 设了密码。',
      passwordIncorrect: '密码不对，请重新输入。',
      passwordLabel: '密码',
      passwordOpen: '打开',
      zoomIn: '放大',
      zoomOut: '缩小'
    },
    popupBlocked: '浏览器拦截了新标签页，请允许本站弹出窗口后再试。',
    previewTitle: '预览',
    previewTooLarge: '文件太大，不能在标签页中打开，请下载后查看。',
    restoreFailed: '恢复失败',
    sheet: {
      empty: '这个表格是空的。',
      sheets: '工作表',
      truncated: (shown: number, rows: number) => `只显示前 ${shown} 行（共 ${rows} 行），完整内容请下载后查看。`,
      unnamed: (index: number) => `工作表 ${index}`
    },
    skillInstallPending: '功能开发中',
    slides: {
      counter: (page: number, pages: number) => `${page} / ${pages}`,
      documentPage: (page: number) => `第 ${page} 页`,
      exitFullscreen: '退出全屏',
      fullscreen: '全屏放映',
      next: '下一页',
      page: (page: number) => `第 ${page} 页`,
      preparing: '正在生成预览…',
      previous: '上一页'
    },
    terminalDisconnected: '和实例的连接断了。关掉这个标签页，再开一个终端。',
    terminalUnavailable: '连不上实例里的命令行，请稍后再试（每台实例最多同时开 8 个终端）。',
    undo: '撤销'
  }
}

/** Copy for the browser build's own messages. Kept here rather than in the
 * upstream locale files, which change with nearly every upstream release.
 * Components pass `useI18n().locale`: the runtime locale is only synced in an
 * effect, after the first render — which the React Compiler may have memoized. */
export function browserShellCopy(locale: string = getRuntimeI18nLocale()): BrowserShellCopy {
  return locale.startsWith('zh') ? COPY.zh : COPY.en
}

/** The skill market's install button (app/skills/skill-market.tsx). A market
 * skill comes as a zip package, which Hermes' install-from-URL does not take (it
 * wants a SKILL.md URL), so the browser build says the feature is in development
 * rather than report an install that never lands. Null where installing goes on. */
export function skillMarketInstallPending(locale?: string): null | string {
  return isBrowserShell() ? browserShellCopy(locale).skillInstallPending : null
}
