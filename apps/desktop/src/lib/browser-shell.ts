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
 *   app/auth/auth-gate.tsx                             no UniWork sign-in page: the entry has signed the user in
 *   app/chat/right-rail/preview-pane.tsx               HTML files from the instance run their scripts, sandboxed
 *   app/chat/sidebar/filter-menu.tsx                   * no profile submenu (filter / new / import)
 *   app/chat/sidebar/index.tsx                         * no messaging platforms entry
 *   app/chat/sidebar/profile-switcher.tsx              * no add / import profile, no "connect gateway"
 *   app/command-palette/index.tsx                      * no in-app browser, Hermes update, theme marketplace, gateway restart
 *   app/profiles/index.tsx                             * no "new profile"
 *   app/right-sidebar/file-actions.tsx                 rename + delete (to the instance's recycle bin) in the menu
 *   app/right-sidebar/terminal/use-terminal-session.ts Ctrl+V / Ctrl+Shift+V paste through the browser
 *   app/settings/about-settings.tsx                    no UniWork account row (signing out is the entry's)
 *   app/settings/appearance-settings.tsx               * no theme marketplace results, no UI scale row
 *   app/settings/index.tsx                             * no Gateway or About page
 *   app/settings/plugins-settings.tsx                  * no desktop (local) plugins section
 *   app/shell/gateway-menu-panel.tsx                   * no gateway restart
 *   contrib/plugins.ts                                 * no Bot Mode (the BOTS tab): its plugin is not started
 *   lib/model-options.ts                               * model pickers: the platform's providers only
 *   store/developer-mode.ts                            flipping UniWork's developer mode reloads the page
 *   store/preview.ts                                   no in-app browser: links and URL previews open in a new tab
 *   store/profile.ts                                   only the default profile
 *   store/zoom.ts                                      no app zoom: the page keeps the browser's own
 *
 * The terminal panel, rename and the recycle bin need no page changes: the
 * bridge implements them against the instance (`/__mt_user/…` behind the
 * entry), see `browser-bridge.ts`.
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
  is_current?: boolean
  is_user_defined?: boolean
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

const SETTINGS_VIEWS_HIDDEN = new Set(['about', 'connections', 'gateway'])

/** Settings pages that only make sense for the desktop app: gateway / SSH
 * connections, and About (app version, self-update, uninstall). */
export function isSettingsViewHidden(view: string): boolean {
  return hideForUsers() && SETTINGS_VIEWS_HIDDEN.has(view)
}

const PALETTE_ITEMS_HIDDEN = new Set(['cc-open-browser', 'cc-restart-gateway', 'cc-update-hermes', 'theme-install'])

/** Command-palette rows for desktop-only features: the in-app browser, updating
 * Hermes from the app (the cloud upgrades instances itself), the theme
 * marketplace, restarting the messaging gateway (an instance runs none). Empty
 * groups go too. */
export function withoutHiddenPaletteItems<G extends { items: readonly { id: string }[] }>(groups: G[]): G[] {
  if (!hideForUsers()) {
    return groups
  }

  return groups
    .map(group => ({ ...group, items: group.items.filter(item => !PALETTE_ITEMS_HIDDEN.has(item.id)) }) as G)
    .filter(group => group.items.length > 0)
}

const SIDEBAR_NAV_HIDDEN = new Set(['messaging'])

/** Sidebar entries for desktop-only features: messaging platforms need an
 * always-on gateway with a public address, which a cloud instance (paused when
 * idle) does not have. */
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

type AppZoom = Window['hermesDesktop']['zoom']

const NO_APP_ZOOM: NonNullable<AppZoom> = {
  get: async () => ({ level: Math.log(0.9) / Math.log(1.2), percent: 90 }),
  onChanged: () => () => undefined,
  setPercent: () => undefined
}

/** App zoom in the browser build: none. The desktop app zooms its window over
 * IPC; a page keeps the browser's own zoom (Ctrl +/-), as upstream does without
 * that IPC. `store/zoom.ts` gets a fixed 90% (its default) and a setter that does
 * nothing, so it never puts a CSS zoom on the page. */
export function browserShellZoom(): AppZoom {
  return isBrowserShell() ? NO_APP_ZOOM : undefined
}

/** Codes the instance's file endpoints answer with (`deploy/hermes-mt/seed/mtuser.py`). */
export type InstanceFileErrorCode = 'exists' | 'invalid_name' | 'not_found' | 'outside' | 'protected'

interface BrowserShellCopy {
  agentOpenedLink: (host: string) => string
  deleteBody: (isDirectory: boolean) => string
  deleteConfirm: string
  fileErrors: Record<InstanceFileErrorCode, string>
  instanceLocalUrl: (host: string) => string
  instanceOutdated: string
  movedToTrash: (name: string) => string
  open: string
  popupBlocked: string
  previewTitle: string
  previewTooLarge: string
  restoreFailed: string
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
    movedToTrash: (name: string) => `Moved “${name}” to the recycle bin.`,
    open: 'Open',
    popupBlocked: 'The browser blocked the new tab. Allow pop-ups for this site and try again.',
    previewTitle: 'Preview',
    previewTooLarge: 'This file is too large to open in a tab. Download it instead.',
    restoreFailed: 'Could not restore the file',
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
    movedToTrash: (name: string) => `已把「${name}」移到回收站。`,
    open: '打开',
    popupBlocked: '浏览器拦截了新标签页，请允许本站弹出窗口后再试。',
    previewTitle: '预览',
    previewTooLarge: '文件太大，不能在标签页中打开，请下载后查看。',
    restoreFailed: '恢复失败',
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
