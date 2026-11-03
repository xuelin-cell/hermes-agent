import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { PlanUsagePanel } from '@/app/shell/plan-usage/panel'
import { I18nProvider } from '@/i18n'
import { isPlanUsageHidden } from '@/lib/browser-shell'

import { storeBrowserLogin } from '../../../shared/src/browser-maas-auth.js'

import { browserPlan } from './browser-plan'

vi.mock('@/store/notifications', () => ({ notify: vi.fn() }))

const login = (id: string) => storeBrowserLogin('/hermes', {
  maas_auth: { token: `maas-${id}`, loginId: id, expiresAt: Date.now() + 60_000 }
})

const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete window.document.documentElement.dataset.hermesBrowser
  vi.unstubAllGlobals()
})

it('云端复用套餐面板与刷新契约，只有业务入口收到 Bearer，普通失败保留上次数据', async () => {
  login('alice')
  window.document.documentElement.dataset.hermesBrowser = 'production'
  expect(isPlanUsageHidden()).toBe(true)
  const account = { maskedPhone: '138****1111', expiresAt: Date.now() + 120_000 }
  let fail = false

  const request = vi.fn(async (input: string, options: RequestInit) => {
    expect(new URL(input).origin).toBe(location.origin)
    expect(new Headers(options.headers).get('Authorization')).toBe('Bearer maas-alice')
    expect(options.credentials).toBe('same-origin')
    expect(options.redirect).toBe('error')
    expect(options.body).toBeUndefined()

    return response(fail ? { status: 'failed' } : {
      status: 'available', account, data: {
        productName: 'Cloud plan', endTime: null, expired: false, fetchedAt: Date.now(),
        kind: 'token_plan', windows: [], concurrency: null,
        quota: { total: 1000, used: 250, remaining: 750, usedPercent: 25, unit: null }
      }
    })
  })

  vi.stubGlobal('fetch', request)
  vi.stubGlobal('hermesDesktop', browserPlan('/hermes'))
  expect(isPlanUsageHidden()).toBe(false)
  render(<I18nProvider configClient={null} initialLocale="en"><PlanUsagePanel account={account} /></I18nProvider>)
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Plan usage' }))
  await screen.findByText('Cloud plan')
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
  expect(request.mock.calls[0][0]).toContain('/hermes/__entry/plan/usage')
  fail = true
  fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
  await waitFor(() => expect(request.mock.calls.at(-1)![0]).toContain('/plan/refresh'))
  expect(screen.getByText('Cloud plan')).toBeTruthy()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh usage' })).toHaveProperty('disabled', false))
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
  expect(await window.hermesDesktop.refreshPlanUsage!()).toEqual({ status: 'failed', reason: 'auth' })
  expect(localStorage.getItem('hermes.cloud.auth.v1:/hermes')).toBeNull()
})

it('订阅在点击时开页，拒绝拦截、重复点击、错误市场地址及账号切换后的迟到票据', async () => {
  login('alice')
  const bridge = browserPlan('/hermes')
  const popup = { opener: {}, closed: false, close: vi.fn(), location: { replace: vi.fn() } }
  vi.spyOn(window, 'open').mockReturnValue(null)
  const request = vi.fn(async (_input: string, _options?: RequestInit) => response({ status: 'ready', url: 'https://market.ai-yuanjing.com/#/active?ticket=signed' }))
  vi.stubGlobal('fetch', request)
  expect(await bridge.subscribeMaasPlan()).toEqual({ status: 'failed', reason: 'popup-blocked' })
  expect(request).not.toHaveBeenCalled()
  vi.mocked(window.open).mockReturnValue(popup as never)
  expect(await bridge.subscribeMaasPlan()).toEqual({ status: 'opened' })
  expect(popup.opener).toBeNull()
  expect(popup.location.replace).toHaveBeenCalledWith('https://market.ai-yuanjing.com/#/active?ticket=signed')
  expect(request.mock.calls[0][0]).toContain('/plan/subscribe')
  expect(request.mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(window.open).mock.invocationCallOrder[1])
  request.mockImplementationOnce(async () => response({ status: 'ready', url: 'https://attacker.invalid/' }))
  expect(await bridge.subscribeMaasPlan()).toEqual({ status: 'failed', reason: 'upstream' })
  expect(popup.location.replace).toHaveBeenCalledTimes(1)
  let finish!: (value: Response) => void
  request.mockImplementationOnce(() => new Promise(done => { finish = done }))
  const pending = bridge.subscribeMaasPlan()
  expect(await bridge.subscribeMaasPlan()).toEqual({ status: 'failed', reason: 'upstream' })
  login('bob')
  finish(response({ status: 'ready', url: 'https://market.ai-yuanjing.com/#/active?ticket=old-login' }))
  expect(await pending).toEqual({ status: 'failed', reason: 'upstream' })
  expect(popup.location.replace).toHaveBeenCalledTimes(1)
  expect(popup.close).toHaveBeenCalled()
  vi.restoreAllMocks()
})
