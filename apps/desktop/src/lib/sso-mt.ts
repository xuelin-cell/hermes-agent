// desktop-mt: unified login (docs/企业版对接/1104/统一登录方案.html v2.3, §15). When the entry runs with MT_SSO,
// signing in, switching accounts and signing out belong to the gateway's login page at the site root:
// - The page itself is served without a login (the gateway does not guard static files). At start the bridge
//   asks the entry's `__entry/config`, which sits behind the gateway: a 401 there means nobody is signed in.
// - Signed in, the gateway's `/sso/me` names the account and its session id. When a tab comes back to the
//   front with another sid (another tab switched accounts or signed out), it reloads.
// - A business call answered with 401 means the session ended: ask `/sso/me` once, go to the login page if
//   it agrees (never on a guess, or a stale answer would bounce between the page and the login page).
// - The way to the login page is the entry's own `login` page beside the API (`/agents/login`): the gateway does
//   not guard pages, so a signed-out page reaches it, and the entry redirects to its MT_SSO_LOGIN_URL. The login
//   page's address is configured there alone.
// The gateway's `/sso/me` and `/sso/logout` are fixed by the plan: a signed-out page cannot ask the entry for them.

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

/** The entry's login page for the API base (`/agents/login` for `/agents/api/`), with this page as the way back. */
export function ssoLoginUrl(apiBase: string, prompt?: string): string {
  const page = new URL('../login', new URL(apiBase, window.location.origin)).pathname

  const query = new URLSearchParams({
    redirect_uri: window.location.pathname + window.location.search + window.location.hash
  })

  if (prompt) {
    query.set('prompt', prompt)
  }

  return `${page}?${query}`
}

/** Leaves for the gateway's login page. The returned promise never settles: nothing should render meanwhile. */
export function toSsoLogin(apiBase: string, prompt?: string): Promise<never> {
  window.location.replace(ssoLoginUrl(apiBase, prompt))

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
    return toSsoLogin(apiBase)
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
    return toSsoLogin(apiBase)
  }

  if (account) {
    watchSsoAccount(account.sid)
  }

  return { account: account ?? null, mode: 'sso' }
}

function watchSsoAccount(sid: string): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      return
    }

    void ssoMe().then(
      now => {
        if (!now || now.sid !== sid) {
          window.location.reload()
        }
      },
      () => undefined // the gateway is unreachable for a moment: keep the page
    )
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
        void toSsoLogin(apiBase, 'select_account')
      }

      return response
    }

    checking ??= ssoMe()
      .then(now => {
        if (now === null) {
          void toSsoLogin(apiBase)
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
          window.location.reload()

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
