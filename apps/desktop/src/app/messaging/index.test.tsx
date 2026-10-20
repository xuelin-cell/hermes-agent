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
const reconnectUniAgentGate = vi.fn()

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

/** 为页面提供原接口形状的平台，未填写项保持未配置。 */
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

/** 在隔离路由中渲染产品页面，不启动用户后端或连接真实平台。 */
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
  })
})

describe('MessagingView WeChat QR setup', () => {
  /** 用受控状态覆盖扫码展示，不向真实微信发起请求。 */
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
      await waitFor(() => expect(screen.queryByAltText('Connect by QR code')).toBeNull(), { timeout: 2500 })
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

  it('does not reopen a closed QR panel when the start request arrives late', async () => {
    let finish!: (value: ReturnType<typeof login>) => void
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform({ id: 'weixin', name: 'Weixin' })] })
    startWeixinQrLogin.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve
      })
    )
    await renderMessaging()
    fireEvent.click(await screen.findByRole('button', { name: /Connect with QR code/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await act(async () => {
      finish(login('wait'))
    })
    expect(screen.queryByAltText('Connect by QR code')).toBeNull()
    expect(screen.queryByText('Scan with WeChat')).toBeNull()
    expect(getWeixinQrLogin).not.toHaveBeenCalled()
    expect(watchGatewayRestartOutcome).not.toHaveBeenCalled()
  })

  it('disconnects a connected account only after confirmation', async () => {
    getMessagingPlatforms.mockResolvedValue({
      platforms: [platform({ configured: true, enabled: true, id: 'weixin', name: 'Weixin', state: 'connected' })]
    })
    unbindWeixin.mockResolvedValue({ needs_restart: false, ok: true, restart_started: true })

    await renderMessaging()

    expect(await screen.findByRole('button', { name: /Scan again/ })).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(screen.getByRole('article', { name: 'WeChat ClawBot integration' }))
        .getByRole('button', { name: /^Disconnect$/ }))
    })
    expect(unbindWeixin).not.toHaveBeenCalled()

    const dialog = await screen.findByRole('dialog')
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /^Disconnect$/ }))
    })

    await waitFor(() => expect(unbindWeixin).toHaveBeenCalledWith('default'))
    await waitFor(() => expect(watchGatewayRestartOutcome).toHaveBeenCalled())
  })

  it('ignores confirmation arriving from a poll that was closed in the same interaction', async () => {
    let finish!: (value: ReturnType<typeof login> & { restart_started: boolean }) => void
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform({ id: 'weixin', name: 'Weixin' })] })
    startWeixinQrLogin.mockResolvedValueOnce(login('wait'))
    getWeixinQrLogin.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve
      })
    )
    await renderMessaging()
    fireEvent.click(await screen.findByRole('button', { name: /Connect with QR code/ }))
    await waitFor(() => expect(getWeixinQrLogin).toHaveBeenCalledTimes(1), { timeout: 3000 })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      finish({ ...login('confirmed'), restart_started: true })
    })
    expect(watchGatewayRestartOutcome).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(screen.queryByText('Scan with WeChat')).toBeNull()
  })
})

/** 原生钉钉字段契约，包含不该由简化表单修改的白名单。 */
function dingtalk(patch: Partial<MessagingPlatformInfo> = {}) {
  return platform({
    id: 'dingtalk',
    name: 'DingTalk',
    state: 'not_configured',
    env_vars: [
      {
        key: 'DINGTALK_CLIENT_ID',
        advanced: false,
        prompt: 'Client ID',
        description: '',
        required: true,
        is_password: false,
        is_set: false,
        redacted_value: null,
        url: null
      },
      {
        key: 'DINGTALK_CLIENT_SECRET',
        advanced: false,
        prompt: 'Client Secret',
        description: '',
        required: true,
        is_password: true,
        is_set: false,
        redacted_value: null,
        url: null
      },
      {
        key: 'DINGTALK_ALLOWED_USERS',
        advanced: true,
        prompt: 'Allowed users',
        description: '',
        required: false,
        is_password: false,
        is_set: true,
        redacted_value: 'owner-only',
        url: null
      }
    ],
    ...patch
  })
}

describe('Messaging cards and native configuration', () => {
  it.each([
    ['feishu', 'Feishu bot integration', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
    ['wecom', 'WeCom smart bot integration', 'WECOM_BOT_ID', 'WECOM_SECRET']
  ])('saves %s through its native credential keys', async (id, title, key, secret) => {
    const row = dingtalk({ id, name: id })
    row.env_vars[0].key = key
    row.env_vars[1].key = secret
    getMessagingPlatforms.mockResolvedValue({ platforms: [row] })
    await renderMessaging()
    fireEvent.click(
      within(await screen.findByRole('article', { name: title })).getByRole('button', { name: 'Configure' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(dialog.querySelector('input[type="text"]')!, { target: { value: 'bot-id' } })
    fireEvent.change(dialog.querySelector('input[type="password"]')!, { target: { value: 'bot-secret' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and enable' }))
    await waitFor(() =>
      expect(updateMessagingPlatform).toHaveBeenCalledWith(
        id,
        {
          enabled: true,
          env: { [key]: 'bot-id', [secret]: 'bot-secret' }
        },
        'default'
      )
    )
    expect(runGatewayRestart).not.toHaveBeenCalled()
  })

  it('keeps save disabled when native required fields are unavailable', async () => {
    getMessagingPlatforms.mockResolvedValue({ platforms: [dingtalk({ env_vars: [] })] })
    await renderMessaging()
    fireEvent.click(
      within(await screen.findByRole('article', { name: 'DingTalk bot integration' })).getByRole('button', {
        name: 'Configure'
      })
    )
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByText('Messaging component unavailable').length).toBeGreaterThan(0)
    expect(within(dialog).getByRole('button', { name: 'Save and enable' }).hasAttribute('disabled')).toBe(true)
    expect(updateMessagingPlatform).not.toHaveBeenCalled()
  })

  it('shows the supported cards and reports unavailable RCS without inventing a connection', async () => {
    getMessagingPlatforms.mockResolvedValue({
      platforms: [
        platform({ id: 'qqbot', name: 'QQ Bot' }),
        platform({ id: 'yuanbao', name: 'Yuanbao' }),
        platform({ id: 'wecom_callback', name: 'WeCom Callback' }),
        platform({ id: 'weixin', name: 'Weixin' }),
        dingtalk(),
        platform({ id: 'feishu', name: 'Feishu' }),
        platform({ id: 'wecom', name: 'WeCom' })
      ]
    })
    await renderMessaging()
    await screen.findByRole('article', { name: 'WeChat ClawBot integration' })
    expect(screen.getAllByRole('article').map(card => card.getAttribute('aria-label'))).toEqual([
      'WeChat ClawBot integration',
      'DingTalk bot integration',
      'Feishu bot integration',
      'WeCom smart bot integration',
      '5G messaging gateway (RCS) integration'
    ])
    const rcs = screen.getByRole('article', { name: /5G/ })
    expect(within(rcs).getByRole('status').textContent).toBe('Messaging component unavailable')
    expect(within(rcs).queryByRole('button', { name: 'Configure' })).toBeNull()
    expect(screen.queryByText('QQ Bot')).toBeNull()
    expect(screen.queryByText('WeCom Callback')).toBeNull()
    expect(screen.queryByText('Allowed users')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(updateMessagingPlatform).not.toHaveBeenCalled()
    expect(runGatewayRestart).not.toHaveBeenCalled()
    expect(startWeixinQrLogin).not.toHaveBeenCalled()
  })

  it('reconnects RCS through the account bridge and reflects its real state without restarting other platforms', async () => {
    const rcs = platform({
      id: 'uniagentgate',
      name: '5G',
      configured: true,
      enabled: true,
      gateway_running: false,
      state: 'gateway_stopped'
    })

    getMessagingPlatforms.mockResolvedValue({ platforms: [rcs] })
    window.hermesDesktop = { ...window.hermesDesktop, reconnectUniAgentGate }
    reconnectUniAgentGate.mockResolvedValue({ status: 'failed' })
    await renderMessaging()
    const card = await screen.findByRole('article', { name: /5G/ })
    expect(within(card).getByRole('status').textContent).toBe('Messaging gateway stopped')
    expect(within(card).queryByText(/Personal credentials saved/)).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Open logs' })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Setup guide' }))
    expect(openExternalLink).toHaveBeenCalledWith('https://docs.qq.com/doc/DZmdiTERIT2VjZHJB')

    getMessagingPlatforms.mockResolvedValue({
      platforms: [{ ...rcs, gateway_running: true, state: 'fatal', error_message: 'Registration rejected' }]
    })
    expect(within(card).queryByRole('button', { name: 'Refresh' })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(within(card).getByRole('status').textContent).toBe('Error'))
    expect(reconnectUniAgentGate).toHaveBeenCalledWith('default')
    expect(within(card).getByText('Registration rejected')).toBeTruthy()

    getMessagingPlatforms.mockResolvedValue({ platforms: [{ ...rcs, gateway_running: true, state: 'connected' }] })
    reconnectUniAgentGate.mockResolvedValue({ status: 'connected' })
    fireEvent.click(within(card).getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(within(card).getByRole('status').textContent).toBe('Connected'))
    expect(within(card).queryByText('Registration rejected')).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Reconnect' })).toBeNull()
    expect((within(card).getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement).disabled).toBe(true)
    expect(updateMessagingPlatform).not.toHaveBeenCalled()
    expect(runGatewayRestart).not.toHaveBeenCalled()
  })

  it('explains an old Electron bridge and does not offer reconnect during protocol recovery', async () => {
    const rcs = platform({ id: 'uniagentgate', name: '5G', configured: true,
      enabled: true, gateway_running: true, state: 'fatal' })

    getMessagingPlatforms.mockResolvedValue({ platforms: [rcs] })
    window.hermesDesktop = { ...window.hermesDesktop, reconnectUniAgentGate: undefined }
    await renderMessaging()
    const card = await screen.findByRole('article', { name: /5G/ })
    fireEvent.click(within(card).getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'error', message: expect.stringContaining('component update is not active yet')
    })))
    await waitFor(() => expect((within(card).getByRole('button', { name: 'Reconnect' }) as HTMLButtonElement).disabled).toBe(false))
    getMessagingPlatforms.mockResolvedValue({ platforms: [{ ...rcs, state: 'retrying' }] })
    fireEvent.click(within(card).getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(within(card).queryByRole('button', { name: 'Reconnect' })).toBeNull())
    expect((within(card).getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement).disabled).toBe(true)
    expect(runGatewayRestart).not.toHaveBeenCalled()
  })

  it('saves only necessary credentials in the existing profile and leaves gateway restart explicit', async () => {
    $settingsScopeOverride.set('worker')
    getMessagingPlatforms.mockResolvedValue({ platforms: [dingtalk()] })

    try {
      await renderMessaging()
      fireEvent.click(
        within(await screen.findByRole('article', { name: 'DingTalk bot integration' })).getByRole('button', {
          name: 'Configure'
        })
      )
      const dialog = await screen.findByRole('dialog')
      const inputs = within(dialog).getAllByRole('textbox')
      fireEvent.change(inputs[0], { target: { value: ' app-123 ' } })
      fireEvent.change(dialog.querySelector('input[type="password"]')!, { target: { value: ' secret-123 ' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save and enable' }))
      await waitFor(() =>
        expect(updateMessagingPlatform).toHaveBeenCalledWith(
          'dingtalk',
          {
            enabled: true,
            env: { DINGTALK_CLIENT_ID: 'app-123', DINGTALK_CLIENT_SECRET: 'secret-123' }
          },
          'worker'
        )
      )
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(await screen.findByRole('button', { name: 'Restart now' })).toBeTruthy()
      expect(runGatewayRestart).not.toHaveBeenCalled()
      expect(screen.queryByText('owner-only')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Restart now' }))
      await waitFor(() => expect(runGatewayRestart).toHaveBeenCalledTimes(1))
    } finally {
      $settingsScopeOverride.set(null)
    }
  })

  it('does not write masked credentials or reconnect an unchanged enabled platform', async () => {
    const saved = dingtalk({ configured: true, enabled: true, state: 'connected' })
    saved.env_vars = saved.env_vars.map(field => ({ ...field, is_set: true, redacted_value: 'saved-preview' }))
    getMessagingPlatforms.mockResolvedValue({ platforms: [saved] })
    await renderMessaging()
    fireEvent.click(
      within(await screen.findByRole('article', { name: 'DingTalk bot integration' })).getByRole('button', {
        name: 'Configure'
      })
    )
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Save and enable' }).hasAttribute('disabled')).toBe(true)
    expect(dialog.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(updateMessagingPlatform).not.toHaveBeenCalled()
    expect(runGatewayRestart).not.toHaveBeenCalled()
  })

  it('keeps the input and shows a save failure instead of pretending the platform connected', async () => {
    getMessagingPlatforms.mockResolvedValue({ platforms: [dingtalk()] })
    updateMessagingPlatform.mockRejectedValueOnce(new Error('Save unavailable'))
    await renderMessaging()
    fireEvent.click(
      within(await screen.findByRole('article', { name: 'DingTalk bot integration' })).getByRole('button', {
        name: 'Configure'
      })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(dialog.querySelector('input[type="text"]')!, { target: { value: 'app-123' } })
    fireEvent.change(dialog.querySelector('input[type="password"]')!, { target: { value: 'secret-123' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and enable' }))
    expect(await within(dialog).findByText('Save unavailable')).toBeTruthy()
    expect(dialog.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe('app-123')
    expect(runGatewayRestart).not.toHaveBeenCalled()
  })

  it('disconnects only the selected platform after confirmation, preserving non-credential settings', async () => {
    $settingsScopeOverride.set('worker')
    getMessagingPlatforms.mockResolvedValue({
      platforms: [dingtalk({ configured: true, enabled: true, state: 'connected' })]
    })

    try {
      await renderMessaging()
      fireEvent.click(
        within(await screen.findByRole('article', { name: 'DingTalk bot integration' })).getByRole('button', {
          name: 'Disconnect'
        })
      )
      expect(updateMessagingPlatform).not.toHaveBeenCalled()
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }))
      await waitFor(() =>
        expect(updateMessagingPlatform).toHaveBeenCalledWith(
          'dingtalk',
          {
            enabled: false,
            clear_env: ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET']
          },
          'worker'
        )
      )
      expect(runGatewayRestart).not.toHaveBeenCalled()
    } finally {
      $settingsScopeOverride.set(null)
    }
  })

  it('does not show a configured but stopped WeChat as connected', async () => {
    getMessagingPlatforms.mockResolvedValue({
      platforms: [
        platform({
          id: 'weixin',
          name: 'Weixin',
          configured: true,
          enabled: true,
          gateway_running: false,
          state: 'gateway_stopped'
        })
      ]
    })
    await renderMessaging()
    const card = await screen.findByRole('article', { name: 'WeChat ClawBot integration' })
    expect(within(card).getByRole('status').textContent).toBe('Messaging gateway stopped')
    expect(within(card).queryByText('Connected')).toBeNull()
  })

  it('drops the old configuration dialog on a profile change instead of writing into the new profile', async () => {
    getMessagingPlatforms.mockResolvedValue({ platforms: [dingtalk()] })
    await renderMessaging()
    fireEvent.click(
      within(await screen.findByRole('article', { name: 'DingTalk bot integration' })).getByRole('button', {
        name: 'Configure'
      })
    )
    expect(await screen.findByRole('dialog')).toBeTruthy()

    try {
      await act(async () => {
        $settingsScopeOverride.set('other')
      })
      await waitFor(() => expect(getMessagingPlatforms).toHaveBeenCalledWith('other'))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(updateMessagingPlatform).not.toHaveBeenCalled()
    } finally {
      $settingsScopeOverride.set(null)
    }
  })
})
