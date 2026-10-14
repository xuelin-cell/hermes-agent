// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $settingsScopeOverride } from '@/store/settings-scope'
import type { MessagingPlatformInfo } from '@/types/hermes'

import { MessagingView } from './index'

// Imports are static on purpose: `await import(...)` inside test bodies ran
// against the test timer, and a cold evaluate of the MessagingView graph blew
// the 15s timeout — the timed-out first test then left the DOM empty for
// every later test. vi.mock calls below are hoisted above these imports, so
// the mocks still apply.

const getMessagingPlatforms = vi.fn()
const updateMessagingPlatform = vi.fn()
const getPairing = vi.fn()
const approvePairing = vi.fn()
const revokePairing = vi.fn()
const openExternalLink = vi.fn()
const runGatewayRestart = vi.fn()
const watchGatewayRestartOutcome = vi.fn()
const startTelegramOnboarding = vi.fn()
const getTelegramOnboardingStatus = vi.fn()
const applyTelegramOnboarding = vi.fn()
const notify = vi.fn()
const startWeixinQrLogin = vi.fn()
const getWeixinQrLogin = vi.fn()
const unbindWeixin = vi.fn()

vi.mock('@/hermes', () => ({
  approvePairing: (platformId: string, requestId: string, profile?: null | string) =>
    approvePairing(platformId, requestId, profile),
  getMessagingPlatforms: (profile?: null | string) => getMessagingPlatforms(profile),
  getPairing: (profile?: null | string) => getPairing(profile),
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  revokePairing: (platformId: string, userId: string, profile?: null | string) =>
    revokePairing(platformId, userId, profile),
  setApiRequestProfile: vi.fn(),
  applyTelegramOnboarding: (pairingId: string, ids: string[], profile?: null | string) =>
    applyTelegramOnboarding(pairingId, ids, profile),
  cancelTelegramOnboarding: vi.fn(async () => ({ ok: true })),
  getTelegramOnboardingStatus: (pairingId: string, profile?: null | string) =>
    getTelegramOnboardingStatus(pairingId, profile),
  startTelegramOnboarding: (botName?: string, profile?: null | string) => startTelegramOnboarding(botName, profile),
  updateMessagingPlatform: (id: string, body: unknown, profile?: null | string) =>
    updateMessagingPlatform(id, body, profile)
}))

vi.mock('qrcode', () => ({ toDataURL: vi.fn(async () => 'data:image/png;base64,QR') }))

vi.mock('@/api/weixin-qr', () => ({
  getWeixinQrLogin: (id: string, profile?: null | string) => getWeixinQrLogin(id, profile),
  startWeixinQrLogin: (profile?: null | string) => startWeixinQrLogin(profile),
  unbindWeixin: (profile?: null | string) => unbindWeixin(profile)
}))

// Keep store/profile's side-effecting imports inert (pulled in via the shared
// settings scope store) — same seam as store/profile.test.ts.
vi.mock('@/store/gateway', () => ({
  $gateway: { get: () => null, subscribe: () => () => {} },
  ensureGatewayForAgent: vi.fn(async () => undefined),
  ensureGatewayForProfile: vi.fn(async () => undefined),
  openGatewayForProfile: vi.fn(async () => undefined)
}))
vi.mock('@/lib/query-client', () => ({ invalidateProfileScopedQueries: vi.fn() }))
vi.mock('@/store/starmap', () => ({ resetStarmapGraph: vi.fn() }))

vi.mock('@/lib/external-link', () => ({
  openExternalLink: (href: string) => openExternalLink(href)
}))

vi.mock('@/store/notifications', () => ({
  notify: (notification: unknown) => notify(notification),
  notifyError: vi.fn()
}))

vi.mock('@/store/system-actions', async () => {
  const { atom } = await import('nanostores')

  return {
    $gatewayRestarting: atom(false),
    runGatewayRestart: () => runGatewayRestart(),
    watchGatewayRestartOutcome: () => watchGatewayRestartOutcome()
  }
})

function platform(patch: Partial<MessagingPlatformInfo> = {}): MessagingPlatformInfo {
  return {
    configured: false,
    description: 'A platform.',
    docs_url: '',
    enabled: false,
    env_vars: [],
    gateway_running: true,
    id: 'teams',
    name: 'Microsoft Teams',
    state: 'disabled',
    ...patch
  }
}

beforeEach(() => {
  updateMessagingPlatform.mockResolvedValue({ ok: true, platform: 'teams' })
  getPairing.mockResolvedValue({ approved: [], pending: [] })
  runGatewayRestart.mockResolvedValue(true)
  watchGatewayRestartOutcome.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// Static import at module scope (after the hoisted vi.mock calls) so the
// heavy component-tree transform is paid during collection, not billed against
// the first test's testTimeout — inside a test body it exceeded the budget on
// loaded CI runners and cascaded the whole file (main runs 34599517793,
// 34600757569, 34601269252). Same pattern as chat/index.test.tsx.
void import('./index')

async function renderMessaging() {
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <MemoryRouter>
        <MessagingView />
      </MemoryRouter>
    )
  })

  return result!
}

describe('MessagingView profile scope', () => {
  it('names the active profile explicitly instead of sending an unscoped request', async () => {
    $settingsScopeOverride.set(null)
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform()] })

    await renderMessaging()

    // #118432: the backend resolves an omitted profile against the home it was
    // LAUNCHED under, so "follow the active profile" has to be said out loud
    // rather than left to the ambient fallback.
    await waitFor(() => expect(getMessagingPlatforms).toHaveBeenCalledWith('default'))
    expect(getPairing).toHaveBeenCalledWith('default')
  })
})

describe('MessagingView WeChat QR setup', () => {
  const login = (state: string, qr = 'https://liteapp.weixin.qq.com/q/1') => ({
    message: '',
    qr_content: qr,
    session_id: 'wx-1',
    state
  })

  it('shows the QR code, follows the scan, and settles the gateway restart on the page scope', async () => {
    $settingsScopeOverride.set('worker')
    getMessagingPlatforms.mockResolvedValue({
      platforms: [platform({ id: 'weixin', name: 'Weixin', state: 'not_configured' })]
    })
    startWeixinQrLogin.mockResolvedValue(login('wait'))
    getWeixinQrLogin
      .mockResolvedValueOnce(login('scanned'))
      .mockResolvedValueOnce({ ...login('confirmed'), needs_restart: false, restart_started: true })

    try {
      await renderMessaging()

      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: /Connect with QR code/ }))
      })

      expect(startWeixinQrLogin).toHaveBeenCalledWith('worker')
      expect(await screen.findByAltText('Connect by QR code')).toBeTruthy()
      expect(await screen.findByText('Scanned. Confirm on your phone.', {}, { timeout: 4000 })).toBeTruthy()

      await waitFor(() => expect(watchGatewayRestartOutcome).toHaveBeenCalled(), { timeout: 4000 })
      expect(getWeixinQrLogin).toHaveBeenCalledWith('wx-1', 'worker')
      expect(notify).toHaveBeenCalledWith({
        kind: 'success',
        message: 'WeChat connected; restarting the gateway…',
        title: 'Weixin setup saved'
      })
      expect(screen.queryByAltText('Connect by QR code')).toBeNull()
      // 页面重新读取平台状态，让卡片显示已连接。
      expect(getMessagingPlatforms.mock.calls.length).toBeGreaterThan(1)
    } finally {
      $settingsScopeOverride.set(null)
    }
  })

  it('offers a fresh QR code after the old one expires', async () => {
    getMessagingPlatforms.mockResolvedValue({
      platforms: [platform({ id: 'weixin', name: 'Weixin', state: 'not_configured' })]
    })
    startWeixinQrLogin.mockResolvedValueOnce(login('wait')).mockResolvedValueOnce(login('wait', 'https://q/2'))
    getWeixinQrLogin.mockResolvedValueOnce(login('expired')).mockResolvedValue(login('wait', 'https://q/2'))

    await renderMessaging()
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Connect with QR code/ }))
    })

    const refresh = await screen.findByRole('button', { name: /Refresh QR code/ }, { timeout: 4000 })
    expect(screen.getByText('The QR code has expired.')).toBeTruthy()

    await act(async () => {
      fireEvent.click(refresh)
    })

    expect(startWeixinQrLogin).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('Scan with WeChat')).toBeTruthy()
  })

  it('disconnects a connected account only after confirmation', async () => {
    getMessagingPlatforms.mockResolvedValue({
      platforms: [platform({ configured: true, enabled: true, id: 'weixin', name: 'Weixin', state: 'connected' })]
    })
    unbindWeixin.mockResolvedValue({ needs_restart: false, ok: true, restart_started: true })

    await renderMessaging()

    expect(await screen.findByRole('button', { name: /Scan again/ })).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Disconnect$/ }))
    })
    expect(unbindWeixin).not.toHaveBeenCalled()

    const dialog = await screen.findByRole('dialog')
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /^Disconnect$/ }))
    })

    await waitFor(() => expect(unbindWeixin).toHaveBeenCalledWith('default'))
    await waitFor(() => expect(watchGatewayRestartOutcome).toHaveBeenCalled())
  })
})
