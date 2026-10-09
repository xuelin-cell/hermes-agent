import { getRuntimeI18nLocale } from '@/i18n/runtime'

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
 *   app/chat/sidebar/filter-menu.tsx       no profile submenu (filter / new / import)
 *   app/chat/sidebar/profile-switcher.tsx  no add / import profile, no "connect gateway"
 *   app/command-palette/index.tsx          no in-app browser, Hermes update, theme marketplace
 *   app/profiles/index.tsx                 no "new profile"
 *   app/right-sidebar/file-actions.tsx     delete is permanent (gateway); no rename
 *   app/right-sidebar/files/tree.tsx       F2 / Enter don't start a rename
 *   app/settings/appearance-settings.tsx   no theme marketplace results
 *   app/settings/index.tsx                 no Gateway or About page
 *   app/settings/plugins-settings.tsx      no desktop (local) plugins section
 *   store/preview.ts                       no in-app browser: links and URL previews open in a new tab
 *   store/profile.ts                       only the default profile
 */
export function isBrowserShell(): boolean {
  return typeof document !== 'undefined' && Boolean(document.documentElement?.dataset?.hermesBrowser)
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
  return isBrowserShell() && SETTINGS_VIEWS_HIDDEN.has(view)
}

const PALETTE_ITEMS_HIDDEN = new Set(['cc-open-browser', 'cc-update-hermes', 'theme-install'])

/** Command-palette rows for desktop-only features: the in-app browser, updating
 * Hermes from the app (the cloud upgrades instances itself), the theme
 * marketplace. Empty groups go too. */
export function withoutHiddenPaletteItems<G extends { items: readonly { id: string }[] }>(groups: G[]): G[] {
  if (!isBrowserShell()) {
    return groups
  }

  return groups
    .map(group => ({ ...group, items: group.items.filter(item => !PALETTE_ITEMS_HIDDEN.has(item.id)) }) as G)
    .filter(group => group.items.length > 0)
}

interface BrowserShellCopy {
  deleteBody: (isDirectory: boolean) => string
  deleteConfirm: string
  deleteOutsideWorkspace: string
  instanceLocalUrl: (host: string) => string
  popupBlocked: string
  previewTitle: string
  previewTooLarge: string
}

const COPY: Record<'en' | 'zh', BrowserShellCopy> = {
  en: {
    deleteBody: (isDirectory: boolean) =>
      isDirectory
        ? 'This permanently deletes the folder and everything in it. It cannot be restored.'
        : 'This permanently deletes the file. It cannot be restored.',
    deleteConfirm: 'Delete permanently',
    deleteOutsideWorkspace: 'Only files in the workspace can be deleted.',
    instanceLocalUrl: (host: string) =>
      `${host} is a web service inside your cloud instance. The browser version cannot open it yet.`,
    popupBlocked: 'The browser blocked the new tab. Allow pop-ups for this site and try again.',
    previewTitle: 'Preview',
    previewTooLarge: 'This file is too large to open in a tab. Download it instead.'
  },
  zh: {
    deleteBody: (isDirectory: boolean) =>
      isDirectory ? '将永久删除这个文件夹及其中所有文件，无法恢复。' : '将永久删除，无法恢复。',
    deleteConfirm: '永久删除',
    deleteOutsideWorkspace: '只能删除工作区里的文件。',
    instanceLocalUrl: (host: string) => `这是实例里的网页服务（${host}），浏览器版暂时打不开。`,
    popupBlocked: '浏览器拦截了新标签页，请允许本站弹出窗口后再试。',
    previewTitle: '预览',
    previewTooLarge: '文件太大，不能在标签页中打开，请下载后查看。'
  }
}

/** Copy for the browser build's own messages. Kept here rather than in the
 * upstream locale files, which change with nearly every upstream release.
 * Components pass `useI18n().locale`: the runtime locale is only synced in an
 * effect, after the first render — which the React Compiler may have memoized. */
export function browserShellCopy(locale: string = getRuntimeI18nLocale()): BrowserShellCopy {
  return locale.startsWith('zh') ? COPY.zh : COPY.en
}
