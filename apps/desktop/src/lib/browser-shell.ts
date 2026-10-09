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
 *   app/chat/sidebar/index.tsx             no messaging platforms entry
 *   app/chat/sidebar/profile-switcher.tsx  no add / import profile, no "connect gateway"
 *   app/command-palette/index.tsx          no in-app browser, Hermes update, theme marketplace, gateway restart
 *   app/profiles/index.tsx                 no "new profile"
 *   app/right-sidebar/file-actions.tsx     rename + delete (to the instance's recycle bin) in the menu
 *   app/settings/appearance-settings.tsx   no theme marketplace results
 *   app/settings/index.tsx                 no Gateway or About page
 *   app/settings/plugins-settings.tsx      no desktop (local) plugins section
 *   app/shell/gateway-menu-panel.tsx       no gateway restart
 *   store/preview.ts                       no in-app browser: links and URL previews open in a new tab
 *   store/profile.ts                       only the default profile
 *
 * The terminal panel, rename and the recycle bin need no page changes: the
 * bridge implements them against the instance (`/__mt_user/…` behind the
 * entry), see `browser-bridge.ts`.
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

const PALETTE_ITEMS_HIDDEN = new Set(['cc-open-browser', 'cc-restart-gateway', 'cc-update-hermes', 'theme-install'])

/** Command-palette rows for desktop-only features: the in-app browser, updating
 * Hermes from the app (the cloud upgrades instances itself), the theme
 * marketplace, restarting the messaging gateway (an instance runs none). Empty
 * groups go too. */
export function withoutHiddenPaletteItems<G extends { items: readonly { id: string }[] }>(groups: G[]): G[] {
  if (!isBrowserShell()) {
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
  return isBrowserShell() ? items.filter(item => !SIDEBAR_NAV_HIDDEN.has(item.id)) : items
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
