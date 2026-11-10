// desktop-mt: unified login (docs/企业版对接/统一登录方案.html v2.3, §15). When the entry runs with MT_SSO,
// signing in, switching accounts and signing out belong to the gateway's login page at the site root:
// - The page itself is served without a login (the gateway does not guard static files). At start the bridge
//   asks the entry's `__entry/config`, which sits behind the gateway: a 401 there means nobody is signed in.
// - Signed in, the gateway's `/sso/me` names the account and its session id. When a tab comes back to the
//   front with another sid (another tab switched accounts or signed out), it reloads. Local storage cleared by
//   another page of the origin is checked the same way: it reloads only when the account changed.
// - A business call answered with 401 means the session ended: ask `/sso/me` once, go to the login page if
//   it agrees (never on a guess, or a stale answer would bounce between the page and the login page).
// - The way to the login page is the entry's own `login` page beside the API (`/agents/login`): the gateway does
//   not guard pages, so a signed-out page reaches it, and the entry redirects to its MT_SSO_LOGIN_URL. The login
//   page's address is configured there alone.
// The gateway's `/sso/me` and `/sso/logout` are fixed by the plan: a signed-out page cannot ask the entry for them.

import { readBrowserAuth, storeBrowserLogin } from '../../../shared/src/browser-maas-auth.js'

import { type ClientFields, reloadFor, replaceFor } from './client-events-mt'

export const SSO_PLATFORM = 'agents'
export const SSO_API = '/app/gateway/sso'

/** The gateway's current account (`/sso/me` data). `accountId` is the member id for an enterprise account. */
export interface SsoAccount {
  accountId: string
  accountType: string
  name?: string
  phoneMasked?: string
  sid: string
  tenantId?: string
  tenantName?: string
}

/** `off`: the entry signs people in itself. `sso`: the gateway does; `account` is null when `/sso/me` could not be read. */
export type SsoBoot = { mode: 'off' } | { account: null | SsoAccount; mode: 'sso' }

/**
 * The entry's login page for the API base (`/agents/login` for `/agents/api/`). Signing in again comes back to
 * this page; switching accounts comes back to the app's home, since the session open here is the left account's.
 */
export function ssoLoginUrl(apiBase: string, prompt?: string): string {
  const api = new URL(apiBase, window.location.origin)
  const page = new URL('../login', api).pathname

  const query = new URLSearchParams({
    redirect_uri:
      prompt === 'select_account'
        ? new URL('../', api).pathname
        : window.location.pathname + window.location.search + window.location.hash
  })

  if (prompt) {
    query.set('prompt', prompt)
  }

  return `${page}?${query}`
}

/**
 * Leaves for the gateway's login page. The returned promise never settles: nothing should render meanwhile.
 * `reason` goes to the entry's log first (client-events-mt), so a page that "left by itself" can be explained.
 */
export function toSsoLogin(apiBase: string, prompt?: string, reason?: string, detail?: ClientFields): Promise<never> {
  replaceFor(reason ?? (prompt === 'select_account' ? 'switch-account' : 'signed-out'), ssoLoginUrl(apiBase, prompt), detail)

  return new Promise<never>(() => undefined)
}

/** The current account, null when signed out (401) or not allowed here (403). Throws when the gateway is unreachable. */
export async function ssoMe(): Promise<null | SsoAccount> {
  const response = await fetch(`${SSO_API}/me?platform=${SSO_PLATFORM}`, { cache: 'no-store', credentials: 'same-origin' })

  if (response.status === 401 || response.status === 403) {
    return null
  }

  if (!response.ok) {
    throw new Error(`sso/me ${response.status}`)
  }

  const body = (await response.json()) as { data?: null | SsoAccount }

  return body.data && typeof body.data.sid === 'string' ? body.data : null
}

/** At start: which way this page signs in. Signed out under the gateway, it leaves for the login page instead. */
export async function bootSso(apiBase: string): Promise<SsoBoot> {
  let response: Response

  try {
    response = await fetch(`${apiBase}__entry/config`, { cache: 'no-store', credentials: 'same-origin' })
  } catch {
    return { mode: 'off' }
  }

  if (response.status === 401) {
    return toSsoLogin(apiBase, undefined, 'boot-signed-out')
  }

  const config = (await response.json().catch(() => null)) as null | { sso?: unknown }

  if (config?.sso !== true) {
    return { mode: 'off' }
  }

  let account: null | SsoAccount | undefined

  try {
    account = await ssoMe()
  } catch {
    account = undefined
  }

  if (account === null) {
    return toSsoLogin(apiBase, undefined, 'boot-no-account')
  }

  if (account) {
    watchSsoAccount(account)
  }

  return { account: account ?? null, mode: 'sso' }
}

/** Who an account is in the entry's log: type and the head of the session id, never the whole id. */
function sessionTag(account: SsoAccount): string {
  return `${account.accountType}/${account.sid.slice(0, 6)}`
}

// The account this page started with, and the check of it in flight (several triggers may fire at once).
let watched: null | SsoAccount = null
let checking: null | Promise<boolean> = null

function watchSsoAccount(account: SsoAccount): void {
  if (!watched) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void recheckSsoAccount('visible')
      }
    })
  }

  watched = account
}

/**
 * Asks the gateway whether this page still has the account it started with, and reloads when it does not.
 * True when the page stays: same session, or the gateway unreachable for a moment. `via` names what made the
 * page ask, for the entry's log.
 */
export function recheckSsoAccount(via: string): Promise<boolean> {
  const account = watched

  if (!account) {
    return Promise.resolve(true)
  }

  checking ??= ssoMe()
    .then(
      now => {
        if (!now) {
          reloadFor('signed-out-elsewhere', { from: sessionTag(account), via })

          return false
        }

        if (now.sid !== account.sid) {
          reloadFor('sid-changed', { from: sessionTag(account), to: sessionTag(now), via })

          return false
        }

        return true
      },
      () => true
    )
    .finally(() => {
      checking = null
    })

  return checking
}

/**
 * Another page of the origin cleared local storage (null key) or changed this page's browser login. The login
 * page, the admin console and the account centre share the origin, and may clear it while the same person stays
 * signed in. Under the unified login the account is the gateway's: reload only when it changed, otherwise
 * `restore` puts back what this page keeps there. Without it, the browser login is the account: reload.
 */
export function onSharedStorageChange(event: StorageEvent, loginKey: string, sso: boolean, restore: () => void): void {
  const login = event.key === loginKey && event.oldValue !== event.newValue

  if (event.key !== null && !login) {
    return
  }

  const reason = login ? 'storage-login-changed' : 'storage-cleared'

  if (!sso) {
    reloadFor(reason, login ? { had: Boolean(event.oldValue), has: Boolean(event.newValue) } : {})

    return
  }

  void recheckSsoAccount(reason).then(kept => {
    if (kept) {
      restore()
    }
  })
}

/** How the account reads in the sidebar: the member and the enterprise, or the person. */
export function ssoDisplayName(account: SsoAccount): string {
  const name = account.name || account.phoneMasked || account.accountId

  return account.accountType === 'enterprise' && account.tenantName ? `${name} · ${account.tenantName}` : name
}

/**
 * Business calls under the API base: a 401 means the gateway session may have ended, a 403
 * ACCOUNT_NOT_ALLOWED that this account cannot use the page. The first goes to the login page once
 * `/sso/me` confirms it; the second goes straight to the account choice (`prompt=select_account`), which
 * the login page does not skip, so the two can never bounce.
 */
export function installSsoAuthErrorHandler(apiBase: string): void {
  const original = window.fetch.bind(window)
  const prefix = new URL(apiBase, window.location.origin).pathname
  let checking: null | Promise<void> = null

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await original(input, init)

    if (response.status !== 401 && response.status !== 403) {
      return response
    }

    let path = ''

    try {
      path = new URL(input instanceof Request ? input.url : String(input), window.location.href).pathname
    } catch {
      return response
    }

    if (!path.startsWith(prefix)) {
      return response
    }

    if (response.status === 403) {
      const body = (await response.clone().json().catch(() => null)) as null | { error?: unknown }

      if (body?.error === 'ACCOUNT_NOT_ALLOWED') {
        void toSsoLogin(apiBase, 'select_account', 'not-allowed', { path: path.slice(prefix.length, prefix.length + 60) })
      }

      return response
    }

    checking ??= ssoMe()
      .then(now => {
        if (now === null) {
          void toSsoLogin(apiBase, undefined, 'signed-out', { path: path.slice(prefix.length, prefix.length + 60) })
        }
      })
      .catch(() => undefined)
      .finally(() => {
        checking = null
      })

    return response
  }
}

export interface SsoBlockedCopy {
  logout: string
  recheck: string
  rechecking: string
  stillBlocked: string
  switchAccount: string
  title: string
}

/**
 * An enterprise member the platform keeps out (pending, disabled, no seat…) is still signed in at the
 * gateway: the page says why instead of loading the app, with a way to check again, switch accounts or
 * sign out. The login page used to show this; under the gateway there is no login page of ours.
 */
export function renderSsoBlocked(
  message: string,
  copy: SsoBlockedCopy,
  actions: { logout: () => void; recheck: () => Promise<boolean>; switchAccount: () => void }
): void {
  const root = document.getElementById('root') ?? document.body
  const panel = document.createElement('main')
  panel.dataset.slot = 'sso-blocked'
  panel.setAttribute(
    'style',
    'max-width:420px;margin:15vh auto 0;padding:28px 24px;border:1px solid rgba(127,127,127,.3);border-radius:8px;' +
      'font:14px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif'
  )

  const title = document.createElement('h1')
  title.textContent = copy.title
  title.setAttribute('style', 'margin:0 0 12px;font-size:18px;font-weight:600')

  const text = document.createElement('p')
  text.textContent = message
  text.setAttribute('role', 'status')
  text.setAttribute('style', 'margin:0 0 20px;opacity:.8')

  const row = document.createElement('div')
  row.setAttribute('style', 'display:flex;gap:8px;flex-wrap:wrap')

  const button = (label: string, onClick: (target: HTMLButtonElement) => void) => {
    const element = document.createElement('button')
    element.type = 'button'
    element.textContent = label
    element.setAttribute('style', 'padding:6px 14px;border-radius:6px;border:1px solid rgba(127,127,127,.4);background:none;color:inherit;font:inherit;cursor:pointer')
    element.addEventListener('click', () => onClick(element))
    row.append(element)

    return element
  }

  button(copy.recheck, target => {
    target.disabled = true
    target.textContent = copy.rechecking
    void actions
      .recheck()
      .catch(() => false)
      .then(allowed => {
        if (allowed) {
          reloadFor('access-recheck')

          return
        }

        target.disabled = false
        target.textContent = copy.recheck
        text.textContent = `${message}（${copy.stillBlocked}）`
      })
  })
  button(copy.switchAccount, () => actions.switchAccount())
  button(copy.logout, () => actions.logout())

  panel.append(title, text, row)
  root.replaceChildren(panel)
}

/**
 * The personal entry's account modules (shared/src/browser-maas-auth.js) send the browser's MaaS login with each
 * call. Under the unified login the token stays in the entry, which takes it from the gateway by session and
 * ignores what the browser sends: a placeholder keeps those modules working unchanged.
 *
 * It is written only when this account has none yet. Every other tab of the site reloads when this key changes
 * (browser-bridge's storage listener, there for account switches), and a placeholder rewritten at each start —
 * with a fresh expiry, so a different value — made two open tabs reload each other forever.
 */
export function keepSsoPlaceholderLogin(apiBase: string, account: string): void {
  const loginId = `sso:${account}`

  if (readBrowserAuth(apiBase)?.loginId === loginId) {
    return
  }

  storeBrowserLogin(apiBase, { maas_auth: { expiresAt: Date.now() + 30 * 86_400_000, loginId, token: 'sso' } })
}
