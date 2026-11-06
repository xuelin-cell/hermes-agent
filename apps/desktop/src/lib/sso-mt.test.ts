import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { browserAuthKey } from '../../../shared/src/browser-maas-auth.js'

import { bootSso, installSsoAuthErrorHandler, keepSsoPlaceholderLogin, renderSsoBlocked, ssoDisplayName, ssoLoginUrl } from './sso-mt'

const originalLocation = window.location
const originalFetch = window.fetch

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status })
}

let replaced: string[]
let reloaded: number

beforeEach(() => {
  replaced = []
  reloaded = 0
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      hash: '#top',
      href: 'http://site.test/agents/chat?id=1#top',
      origin: 'http://site.test',
      pathname: '/agents/chat',
      reload: () => {
        reloaded += 1
      },
      replace: (url: string) => {
        replaced.push(url)
      },
      search: '?id=1'
    }
  })
})

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  window.fetch = originalFetch
  globalThis.fetch = originalFetch
  document.body.replaceChildren()
})

function route(table: Record<string, () => Response>) {
  const calls: string[] = []

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const handler = Object.entries(table).find(([prefix]) => url.startsWith(prefix))?.[1]

    return handler ? handler() : jsonResponse({}, 404)
  }) as typeof fetch
  window.fetch = globalThis.fetch

  return calls
}

const ACCOUNT = { accountId: 'm-1', accountType: 'enterprise', name: '张三', sid: 'sid-1', tenantId: 't-1', tenantName: '一号企业' }

describe('unified login (desktop-mt)', () => {
  it('goes through the login page of the entry beside the API, with this page as the way back', () => {
    // the entry redirects to its MT_SSO_LOGIN_URL: the gateway login page is configured in one place
    const url = new URL(ssoLoginUrl('/agents/api/', 'select_account'), 'http://site.test')

    expect(url.pathname).toBe('/agents/login')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      prompt: 'select_account',
      redirect_uri: '/agents/chat?id=1#top'
    })
  })

  it('stays out of the way when the entry signs people in itself', async () => {
    const calls = route({ '/agents/api/__entry/config': () => jsonResponse({ sso: false }) })

    await expect(bootSso('/agents/api/')).resolves.toEqual({ mode: 'off' })
    expect(calls).toEqual(['/agents/api/__entry/config'])
    expect(replaced).toEqual([])
  })

  it('goes to the login page when the gateway says nobody is signed in', async () => {
    route({ '/agents/api/__entry/config': () => jsonResponse({ error: 'LOGIN_REQUIRED' }, 401) })
    const boot = bootSso('/agents/api/')

    await vi.waitFor(() => expect(replaced).toHaveLength(1))
    expect(replaced[0]).toMatch(/^\/agents\/login\?redirect_uri=/)

    let settled = false
    void boot.then(() => (settled = true))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false) // nothing renders while the page leaves
  })

  it('reads the account from /sso/me and reloads when another tab changed it', async () => {
    let current: typeof ACCOUNT | null = ACCOUNT
    route({
      '/agents/api/__entry/config': () => jsonResponse({ sso: true }),
      '/app/gateway/sso/me?platform=agents': () => (current ? jsonResponse({ data: current }) : jsonResponse({}, 401))
    })

    await expect(bootSso('/agents/api/')).resolves.toEqual({ account: ACCOUNT, mode: 'sso' })

    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(reloaded).toBe(0) // same session

    current = { ...ACCOUNT, sid: 'sid-2' }
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(reloaded).toBe(1))
  })

  it('goes to the login page when /sso/me disagrees, and keeps the page when the gateway is unreachable', async () => {
    route({
      '/agents/api/__entry/config': () => jsonResponse({ sso: true }),
      '/app/gateway/sso/me': () => jsonResponse({ error: 'ACCOUNT_NOT_ALLOWED' }, 403)
    })
    void bootSso('/agents/api/')
    await vi.waitFor(() => expect(replaced).toHaveLength(1))

    route({
      '/agents/api/__entry/config': () => jsonResponse({ sso: true }),
      '/app/gateway/sso/me': () => jsonResponse({}, 502)
    })
    await expect(bootSso('/agents/api/')).resolves.toEqual({ account: null, mode: 'sso' })
    expect(replaced).toHaveLength(1)
  })

  it('shows the member with the enterprise, and the person alone', () => {
    expect(ssoDisplayName(ACCOUNT)).toBe('张三 · 一号企业')
    expect(ssoDisplayName({ accountId: 'u-1', accountType: 'personal', name: '', phoneMasked: '138****0001', sid: 's' })).toBe(
      '138****0001'
    )
  })

  it('checks a 401 against /sso/me before leaving, and sends 403 ACCOUNT_NOT_ALLOWED to the account choice', async () => {
    let signedIn = true

    const calls = route({
      '/agents/api/__hermes_backend/': () => jsonResponse({ error: 'LOGIN_REQUIRED' }, 401),
      '/agents/api/__entry/odd': () => jsonResponse({ error: 'ACCOUNT_NOT_ALLOWED' }, 403),
      '/agents/api/__entry/blocked': () => jsonResponse({ error: 'enterprise_access_denied' }, 403),
      '/app/gateway/sso/me': () => (signedIn ? jsonResponse({ data: ACCOUNT }) : jsonResponse({}, 401)),
      '/elsewhere': () => jsonResponse({}, 401)
    })

    installSsoAuthErrorHandler('/agents/api/')

    expect((await window.fetch('/agents/api/__hermes_backend/api/sessions')).status).toBe(401)
    await vi.waitFor(() => expect(calls).toContain('/app/gateway/sso/me?platform=agents'))
    await new Promise(resolve => setTimeout(resolve, 10)) // let that check finish
    expect(replaced).toEqual([]) // still signed in at the gateway: no bouncing

    signedIn = false
    await window.fetch('/agents/api/__hermes_backend/api/sessions')
    await vi.waitFor(() => expect(replaced).toHaveLength(1))

    await window.fetch('/elsewhere') // not ours
    await window.fetch('/agents/api/__entry/blocked') // the page shows this one itself
    expect(replaced).toHaveLength(1)

    await window.fetch('/agents/api/__entry/odd')
    await vi.waitFor(() => expect(replaced).toHaveLength(2))
    expect(replaced[1]).toContain('prompt=select_account')
  })

  it('keeps a blocked member on a page that says why, with a way out', async () => {
    let allowed = false

    const actions = { logout: vi.fn(), recheck: vi.fn(async () => allowed), switchAccount: vi.fn() }

    const copy = {
      logout: '退出',
      recheck: '重新检查',
      rechecking: '检查中…',
      stillBlocked: '仍未放行',
      switchAccount: '切换账号',
      title: '企业还没有放行你的账号'
    }

    renderSsoBlocked('你还没有分配企业席位，请联系管理员', copy, actions)

    const panel = document.querySelector('[data-slot="sso-blocked"]')!
    expect(panel.textContent).toContain('你还没有分配企业席位')
    const [recheck, switchAccount, logout] = Array.from(panel.querySelectorAll('button'))

    recheck.click()
    await vi.waitFor(() => expect(panel.textContent).toContain('仍未放行'))
    expect(reloaded).toBe(0)

    allowed = true
    recheck.click()
    await vi.waitFor(() => expect(reloaded).toBe(1))

    switchAccount.click()
    logout.click()
    expect(actions.switchAccount).toHaveBeenCalledOnce()
    expect(actions.logout).toHaveBeenCalledOnce()
  })
})

describe('placeholder login under the unified login', () => {
  afterEach(() => {
    localStorage.clear()
    vi.useRealTimers()
  })

  it('is not rewritten by a later start of the same account, so other tabs are not reloaded', () => {
    vi.useFakeTimers()
    const key = () => browserAuthKey('/agents/api/')

    keepSsoPlaceholderLogin('/agents/api/', 'u-1')
    const first = localStorage.getItem(key())

    vi.advanceTimersByTime(60_000) // another tab starts a minute later
    keepSsoPlaceholderLogin('/agents/api/', 'u-1')
    expect(localStorage.getItem(key())).toBe(first)

    keepSsoPlaceholderLogin('/agents/api/', 'u-2') // a real account switch still changes it
    expect(localStorage.getItem(key())).not.toBe(first)
    expect(JSON.parse(localStorage.getItem(key())!).loginId).toBe('sso:u-2')
  })
})
