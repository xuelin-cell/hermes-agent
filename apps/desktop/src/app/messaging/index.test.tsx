// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { cleanStores } from 'nanostores'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $settingsScopeOverride } from '@/store/settings-scope'
import type { MessagingPlatformInfo } from '@/types/hermes'

import type { MessagingOperationStatus } from '../../../electron/entry_local/messaging-contract'

import { $dismissedMessagingFailureRevision, $messagingOperation } from './operation-store'

import { MessagingView } from './index'

// Imports are static on purpose: `await import(...)` inside test bodies ran
// against the test timer, and a cold evaluate of the MessagingView graph blew
// the 15s timeout — the timed-out first test then left the DOM empty for
// every later test. vi.mock calls below are hoisted above these imports, so
// the mocks still apply.

const getMessagingPlatforms = vi.fn()
const getStatus = vi.fn()
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
const messagingSetup = vi.fn()
const reconnectUniAgentGate = vi.fn()
const statusListeners = new Set<(status: MessagingOperationStatus) => void>()
let currentStatus: MessagingOperationStatus = { phase: 'idle', revision: 0 }

/** 模拟主进程在页面之外推进任务，并保存供新页面补取的快照。 */
function publishOperation(patch: Partial<MessagingOperationStatus>) {
  currentStatus = { ...currentStatus, ...patch, revision: currentStatus.revision + 1 }

  for (const listener of statusListeners) {listener(currentStatus)}
}

vi.mock('@/hermes', () => ({
  approvePairing: (platformId: string, requestId: string, profile?: null | string) =>
    approvePairing(platformId, requestId, profile),
  getMessagingPlatforms: (profile?: null | string) => getMessagingPlatforms(profile),
  getStatus: (profile?: null | string) => getStatus(profile),
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
  currentStatus = { phase: 'idle', revision: 0 }
  $messagingOperation.set({ phase: 'idle', revision: -1 })
  $dismissedMessagingFailureRevision.set(-1)
  window.hermesDesktop = { ...window.hermesDesktop, messagingSetup,
    messagingStatus: async () => currentStatus,
    onMessagingStatus: listener => {
      statusListeners.add(listener)

      return () => { statusListeners.delete(listener) }
    }
  } as typeof window.hermesDesktop
  messagingSetup.mockResolvedValue({ accepted: true })
  getStatus.mockResolvedValue({ gateway_running: false, gateway_state: 'stopped', gateway_platforms: {} })
  updateMessagingPlatform.mockResolvedValue({ ok: true, platform: 'teams' })
  getPairing.mockResolvedValue({ approved: [], pending: [] })
  runGatewayRestart.mockResolvedValue(true)
  watchGatewayRestartOutcome.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  cleanStores($messagingOperation)
  statusListeners.clear()
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

describe('MessagingView gateway error ownership', () => {
  it.each([
    { reason: 'uniagentgate: registration rejected', diagnosis: true, unavailable: false },
    { reason: 'Registration rejected without a platform prefix', diagnosis: true, unavailable: false },
    { reason: 'Port 8642 already in use', diagnosis: false, unavailable: false },
    { reason: 'Status temporarily unavailable', diagnosis: false, unavailable: true }
  ])(
    'shows only an owned channel diagnosis and keeps the existing recovery banner: $reason',
    async ({ reason, diagnosis, unavailable }) => {
      $settingsScopeOverride.set(null)
      publishOperation({ phase: 'failed', operation: 'restore', saved: true })

      const rows = ['weixin', 'uniagentgate'].map(id => platform({
        id, enabled: true, configured: true, gateway_running: false,
        state: 'startup_failed', error_code: 'startup_failed', error_message: reason
      }))

      getMessagingPlatforms.mockResolvedValue({ platforms: rows })

      if (unavailable) {
        getStatus.mockRejectedValue(new Error('status unavailable'))
      } else {
        getStatus.mockResolvedValue({
          gateway_running: false, gateway_state: 'startup_failed',
          gateway_platforms: diagnosis ? { uniagentgate: {
            state: 'fatal', error_code: 'connection_failed', error_message: reason
          } } : {}
        })
      }

      await renderMessaging()
      const weixin = await screen.findByRole('article', { name: /WeChat/ })
      const rcs = await screen.findByRole('article', { name: /5G/ })
      expect(within(weixin).queryByText(reason)).toBeNull()
      expect(!!within(rcs).queryByText(reason)).toBe(diagnosis)
      expect(screen.queryByText('Last messaging gateway startup failed')).toBeNull()
      expect(screen.getByText(/Messaging could not be restored/)).toBeTruthy()
      expect(getStatus).toHaveBeenCalledWith('default')
      expect(messagingSetup).not.toHaveBeenCalled()

      if (diagnosis) {
        getStatus.mockResolvedValue({ gateway_running: true, gateway_state: 'running', gateway_platforms: {
          uniagentgate: { state: 'fatal', error_message: reason }
        } })
        await act(async () => { publishOperation({ phase: 'checking' }) })
        await waitFor(() => expect(within(rcs).queryByText(reason)).toBeNull())
      }

      getMessagingPlatforms.mockResolvedValue({ platforms: rows.map(row => ({
        ...row, gateway_running: true, state: 'connected', error_code: null, error_message: null
      })) })
      await act(async () => { publishOperation({ phase: 'completed' }) })
      await waitFor(() => expect(within(weixin).getByRole('status').textContent).toBe('Connected'))
      expect(screen.queryByText(reason)).toBeNull()
      expect(getStatus.mock.calls.every(([profile]) => profile === 'default')).toBe(true)
      expect(rows.every(row => row.error_message === reason)).toBe(true)

      for (const state of ['fatal', 'retrying', 'startup_failed']) {
        getMessagingPlatforms.mockResolvedValue({ platforms: [
          { ...rows[0], gateway_running: true, state: 'connected', error_message: null },
          { ...rows[1], gateway_running: true, state, error_message: reason }
        ] })
        await act(async () => { publishOperation({ phase: 'completed' }) })
        await waitFor(() => expect(within(rcs).getByText(reason)).toBeTruthy())
        expect(within(weixin).queryByText(reason)).toBeNull()
        expect(screen.queryByText('Last messaging gateway startup failed')).toBeNull()
      }
    }
  )
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

      await waitFor(() => expect(messagingSetup).toHaveBeenCalledWith({ operation: 'watch', platform: 'weixin', profile: 'worker' }), { timeout: 4000 })
      expect(getWeixinQrLogin).toHaveBeenCalledWith('wx-1', 'worker')
      expect(notify).not.toHaveBeenCalled()
      expect(watchGatewayRestartOutcome).not.toHaveBeenCalled()
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

    await waitFor(() => expect(messagingSetup).toHaveBeenCalledWith({ operation: 'disconnect', platform: 'weixin', profile: 'default' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(watchGatewayRestartOutcome).not.toHaveBeenCalled()
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
  it('校验失败可以关闭；轮询和重进页面不重复展示，新一次失败仍显示', async () => {
    publishOperation({ phase: 'failed', operation: 'save', platform: 'feishu', profile: 'default',
      saved: false, error: 'validation_network' })
    getMessagingPlatforms.mockResolvedValue({ platforms: [
      platform({ id: 'feishu' }), dingtalk({ enabled: true, configured: true, state: 'connected' })
    ] })
    const failure = 'Could not reach the platform. Your saved settings are unchanged.'
    const view = await renderMessaging()
    expect(await screen.findByText(failure)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByText(failure)).toBeNull()
    await act(async () => { window.document.dispatchEvent(new Event('visibilitychange')) })
    expect(screen.queryByText(failure)).toBeNull()

    view.rerender(<MemoryRouter><div>Desktop chat</div></MemoryRouter>)
    view.rerender(<MemoryRouter><MessagingView /></MemoryRouter>)
    await screen.findByRole('article', { name: 'Feishu bot integration' })
    expect(screen.queryByText(failure)).toBeNull()
    expect(currentStatus).toMatchObject({ phase: 'failed', saved: false, error: 'validation_network' })
    expect(messagingSetup).not.toHaveBeenCalled()

    await act(async () => { publishOperation({ phase: 'failed', error: 'validation_network' }) })
    expect(await screen.findByText(failure)).toBeTruthy()
  })

  it('关闭一次操作错误不掩盖当前渠道故障，也不停止原版重连', async () => {
    publishOperation({ phase: 'failed', operation: 'save', platform: 'feishu', profile: 'default',
      saved: false, error: 'validation_timeout' })
    const detail = 'Feishu websocket link lost; reconnecting'
    getMessagingPlatforms.mockResolvedValue({ platforms: [
      platform({ id: 'feishu', enabled: true, configured: true, state: 'fatal', error_message: detail })
    ] })
    await renderMessaging()
    expect(await screen.findByText(/Validation timed out/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByText(/Validation timed out/)).toBeNull()
    expect(screen.getByText(detail)).toBeTruthy()
    expect(screen.getByText(/Some messaging connections are unavailable/)).toBeTruthy()
    const card = within(screen.getByRole('article', { name: 'Feishu bot integration' }))
    expect(card.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(card.getByRole('button', { name: 'Disconnect' })).toBeTruthy()
    expect(messagingSetup).not.toHaveBeenCalled()
  })

  it('关闭提示不影响下一次操作进度、成功和执行失败的展示', async () => {
    publishOperation({ phase: 'failed', operation: 'save', platform: 'feishu', profile: 'default',
      saved: false, error: 'validation_network' })
    getMessagingPlatforms.mockResolvedValue({ platforms: [platform({ id: 'feishu' })] })
    await renderMessaging()
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await act(async () => { publishOperation({ phase: 'saving', error: undefined }) })
    expect(await screen.findByText('Validating and saving messaging settings…')).toBeTruthy()
    await act(async () => { publishOperation({ phase: 'completed', saved: true }) })
    expect(await screen.findByText('Messaging settings applied.')).toBeTruthy()
    await act(async () => { publishOperation({ phase: 'failed', saved: true, error: 'apply_failed' }) })
    expect(await screen.findByText(/Settings saved, but the messaging connection/)).toBeTruthy()
  })

  it('即时请求错误也可以关闭，不重发请求或更改平台配置', async () => {
    getMessagingPlatforms.mockResolvedValue({ platforms: [
      platform({ id: 'feishu', enabled: true, configured: true, state: 'retrying' })
    ] })
    messagingSetup.mockRejectedValueOnce(new Error('IPC unavailable'))
    await renderMessaging()
    fireEvent.click(within(await screen.findByRole('article', { name: 'Feishu bot integration' }))
      .getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(/Settings saved, but the messaging connection/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByText(/Settings saved, but the messaging connection/)).toBeNull()
    expect(screen.getByText(/reconnecting using its built-in policy/)).toBeTruthy()
    expect(messagingSetup).toHaveBeenCalledTimes(1)
  })

  it.each([
    { enabled: true, credential: false, unbind: true },
    { enabled: false, credential: true, unbind: true },
    { enabled: false, credential: false, unbind: false }
  ])('不完整配置仍可清理，完全未绑定不提供解绑：$enabled/$credential', async ({ enabled, credential, unbind }) => {
    $settingsScopeOverride.set('worker')
    const row = dingtalk({ id: 'feishu', enabled, error_message: 'Feishu websocket link lost; reconnecting' })
    row.env_vars[0].key = 'FEISHU_APP_ID'
    row.env_vars[0].is_set = credential
    row.env_vars[1].key = 'FEISHU_APP_SECRET'
    getMessagingPlatforms.mockResolvedValue({ platforms: [row] })

    try {
      await renderMessaging()
      const card = within(await screen.findByRole('article', { name: 'Feishu bot integration' }))
      expect(!!card.queryByRole('button', { name: 'Disconnect' })).toBe(unbind)
      expect(card.queryByRole('button', { name: 'Retry' })).toBeNull()
      expect(!!card.queryByText(row.error_message!)).toBe(enabled)

      if (unbind) {
        fireEvent.click(card.getByRole('button', { name: 'Disconnect' }))
        expect(messagingSetup).not.toHaveBeenCalled()
        fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }))
        await waitFor(() =>
          expect(messagingSetup).toHaveBeenCalledWith({
            operation: 'disconnect',
            platform: 'feishu',
            profile: 'worker'
          })
        )
      }
    } finally {
      $settingsScopeOverride.set(null)
    }
  })

  it.each(['retrying', 'fatal', 'disconnected'])('飞书 %s 卡片同时提供重试和解绑，已连接渠道保持原状', async state => {
    const feishu = platform({
      id: 'feishu',
      configured: true,
      enabled: true,
      state,
      error_message: 'Feishu websocket link lost; reconnecting'
    })

    getMessagingPlatforms.mockResolvedValue({
      platforms: [feishu, dingtalk({ enabled: true, configured: true, state: 'connected' })]
    })
    await renderMessaging()
    const card = within(await screen.findByRole('article', { name: 'Feishu bot integration' }))
    expect(card.getByRole('button', { name: 'Disconnect' })).toBeTruthy()
    expect(card.getByText(feishu.error_message!)).toBeTruthy()
    fireEvent.click(card.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(messagingSetup).toHaveBeenCalledWith({
      operation: 'retry',
        profile: 'default'
      })
    )
    const dingtalkCard = within(screen.getByRole('article', { name: 'DingTalk bot integration' }))
    expect(dingtalkCard.getByRole('status').textContent).toBe('Connected')
    expect(dingtalkCard.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('解绑生效后移除飞书旧错误和超时，保留其它渠道的真实故障', async () => {
    publishOperation({
      phase: 'failed',
      operation: 'disconnect',
      platform: 'feishu',
      profile: 'default',
      saved: true,
      error: 'connection_timeout'
    })

    const feishu = platform({
      id: 'feishu',
      configured: true,
      enabled: true,
      state: 'retrying',
      error_message: 'Feishu websocket link lost; reconnecting'
    })

    const other = dingtalk({
      enabled: true,
      configured: true,
      state: 'fatal',
      error_message: 'DingTalk authentication rejected'
    })

    getMessagingPlatforms.mockResolvedValue({ platforms: [feishu, other] })
    await renderMessaging()
    expect(await screen.findByText(feishu.error_message!)).toBeTruthy()
    expect(screen.getByText(/Settings saved, but the messaging connection/)).toBeTruthy()

    getMessagingPlatforms.mockResolvedValue({
      platforms: [{ ...feishu, enabled: false, configured: false, state: 'disabled' }, other]
    })
    await act(async () => {
      window.document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(screen.queryByText(feishu.error_message!)).toBeNull())
    expect(screen.queryByText(/Settings saved, but the messaging connection/)).toBeNull()
    expect(screen.getByText(other.error_message!)).toBeTruthy()
    const card = within(screen.getByRole('article', { name: 'Feishu bot integration' }))
    expect(card.queryByRole('button', { name: 'Disconnect' })).toBeNull()
    expect(card.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(card.getByRole('button', { name: 'Configure' })).toBeTruthy()
    expect(messagingSetup).not.toHaveBeenCalled()
  })

  it.each([
    { error: 'apply_failed', saved: true },
    { error: 'index_failed', saved: true },
    { error: 'connection_timeout', saved: false }
  ])('解绑后的新快照不能掩盖 $error/$saved 保存或执行错误', async ({ error, saved }) => {
    publishOperation({ phase: 'failed', operation: 'disconnect', platform: 'feishu', profile: 'default', saved, error })
    getMessagingPlatforms.mockResolvedValue({
      platforms: [platform({ id: 'feishu' }), dingtalk({ enabled: true, configured: true, state: 'connected' })]
    })
    await renderMessaging()
    expect(
      await screen.findByText(
        saved ? /Settings saved, but the messaging connection/ : /Could not save messaging settings/
      )
    ).toBeTruthy()
  })

  it.each(['save', 'retry', 'watch'] as const)('clears a historical %s connection timeout only after fresh recovery', async operation => {
    publishOperation({ phase: 'failed', operation, platform: 'dingtalk', profile: 'default', saved: true, error: 'connection_timeout' })
    const row = dingtalk({ configured: true, enabled: true, state: 'retrying' })
    getMessagingPlatforms.mockResolvedValue({ platforms: [row] })
    await renderMessaging()
    expect(await screen.findByText(/Settings saved, but the messaging connection/)).toBeTruthy()
    getMessagingPlatforms.mockResolvedValue({ platforms: [{ ...row, state: 'connected' }] })
    await act(async () => { window.document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(screen.queryByText(/Settings saved, but the messaging connection/)).toBeNull())
    expect(messagingSetup).not.toHaveBeenCalled()
    expect(currentStatus.phase).toBe('failed')
  })

  it('does not hide a saved target failure because another platform is healthy', async () => {
    publishOperation({ phase: 'failed', operation: 'save', platform: 'dingtalk', profile: 'default', saved: true, error: 'connection_timeout' })
    getMessagingPlatforms.mockResolvedValue({ platforms: [
      dingtalk({ enabled: true, configured: false }),
      platform({ id: 'weixin', enabled: true, configured: true, state: 'connected' })
    ] })
    await renderMessaging()
    expect(await screen.findByText(/Settings saved, but the messaging connection/)).toBeTruthy()
  })

  it.each([{ ids: ['weixin', 'uniagentgate'] }, { ids: ['uniagentgate'] }])(
    'clears a historical restore failure when current configured channels recover: $ids',
    async ({ ids }) => {
      $settingsScopeOverride.set(null)
      publishOperation({ phase: 'failed', operation: 'restore', profile: 'default', saved: true, error: 'connection_timeout' })

      const rows = ids.map(id => platform({
        id, enabled: true, configured: true, state: id === 'uniagentgate' ? 'retrying' : 'connected'
      }))

      const unconfigured = platform({ id: 'dingtalk' })
      getMessagingPlatforms.mockResolvedValue({ platforms: [...rows, unconfigured] })
      const view = await renderMessaging()
      expect(await screen.findByText(/Messaging could not be restored/)).toBeTruthy()

      getMessagingPlatforms.mockResolvedValue({ platforms: [
        ...rows.map(row => ({ ...row, state: 'connected' })), unconfigured
      ] })
      await act(async () => { window.document.dispatchEvent(new Event('visibilitychange')) })
      await waitFor(() => expect(screen.queryByText(/Messaging could not be restored/)).toBeNull())
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
      expect(currentStatus).toMatchObject({ phase: 'failed', operation: 'restore' })
      expect(messagingSetup).not.toHaveBeenCalled()

      view.rerender(<MemoryRouter><div>Desktop chat</div></MemoryRouter>)
      view.rerender(<MemoryRouter><MessagingView /></MemoryRouter>)
      await waitFor(() => expect(within(screen.getByRole('article', { name: /5G/ }))
        .getByRole('status').textContent).toBe('Connected'))
      expect(screen.queryByText(/Messaging could not be restored/)).toBeNull()
    }
  )

  it('进入页面读取平台状态期间，不先闪出历史启动恢复失败', async () => {
    $settingsScopeOverride.set(null)
    publishOperation({ phase: 'failed', operation: 'restore', profile: 'default', saved: true, error: 'connection_timeout' })
    const row = dingtalk({ configured: true, enabled: true, state: 'connected' })
    let release!: (value: { platforms: MessagingPlatformInfo[] }) => void
    getMessagingPlatforms.mockReturnValue(new Promise(resolve => { release = resolve }))
    await renderMessaging()
    await act(async () => undefined)
    expect(screen.queryByText(/Messaging could not be restored/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    await act(async () => { release({ platforms: [row] }) })
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'DingTalk bot integration' }))
      .getByRole('status').textContent).toBe('Connected'))
    expect(screen.queryByText(/Messaging could not be restored/)).toBeNull()
  })

  it('启动恢复超时但平台仍在连接时，按正在重连展示，不当作失败', async () => {
    $settingsScopeOverride.set(null)
    publishOperation({ phase: 'failed', operation: 'restore', profile: 'default', saved: true, error: 'connection_timeout' })
    getMessagingPlatforms.mockResolvedValue({ platforms: [dingtalk({ configured: true, enabled: true, state: 'retrying' })] })
    await renderMessaging()
    expect(await screen.findByText(/reconnecting using its built-in policy/)).toBeTruthy()
    expect(screen.queryByText(/Messaging could not be restored/)).toBeNull()
    expect(messagingSetup).not.toHaveBeenCalled()
  })

  it.each([
    { operation: 'save' as const, error: 'apply_failed', saved: true, profile: 'default',
      message: 'Settings saved, but the messaging connection could not be restored. Retry the connection.' },
    { operation: 'save' as const, error: 'index_failed', saved: true, profile: 'default',
      message: 'Settings saved, but the messaging connection could not be restored. Retry the connection.' },
    { operation: 'save' as const, error: 'credentials_rejected', saved: false, profile: 'default',
      message: 'ID or Secret was rejected.' },
    { operation: 'restore' as const, error: 'gateway_identity_unverified', saved: true, profile: 'default',
      message: 'The existing gateway’s ownership could not be verified. No new gateway was started. Open logs for details.' },
    { operation: 'restore' as const, error: 'connection_timeout', saved: true, profile: 'another-profile',
      message: 'Messaging could not be restored. Desktop chat is available. Retry the connection or open logs.' }
  ])('keeps $error for $profile visible when the saved channel is connected', async ({ operation, error, saved, profile, message }) => {
    $settingsScopeOverride.set(null)
    publishOperation({ phase: 'failed', operation, profile, saved, error })
    getMessagingPlatforms.mockResolvedValue({ platforms: [
      dingtalk({ configured: true, enabled: true, state: 'connected' })
    ] })
    await renderMessaging()
    expect(await screen.findByText(message)).toBeTruthy()
    await act(async () => { window.document.dispatchEvent(new Event('visibilitychange')) })
    expect(screen.getByText(message)).toBeTruthy()
  })

  it.each(['retrying', 'fatal'])('运行期 %s 保留原版原因并提供恢复入口，不自行重启网关', async state => {
    const detail = state === 'fatal' ? 'Authentication rejected' : 'Network temporarily unavailable'
    getMessagingPlatforms.mockResolvedValue({ platforms: [dingtalk({ configured: true, enabled: true, state, error_message: detail })] })
    await renderMessaging()
    expect(await screen.findByText(detail)).toBeTruthy()
    expect(within(screen.getByRole('article', { name: 'DingTalk bot integration' })).getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open logs' })).toBeTruthy()
    expect(messagingSetup).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('自动恢复不依赖页面，失败后进入消息页可查看日志和安全重试', async () => {
    getMessagingPlatforms.mockResolvedValue({ platforms: [dingtalk({
      configured: true, enabled: true, state: 'retrying', error_message: 'Original adapter is reconnecting'
    })] })
    const revealLogs = vi.fn(async () => ({ ok: true, path: '' }))
    window.hermesDesktop.revealLogs = revealLogs
    publishOperation({ phase: 'applying', saved: true, operation: 'restore' })
    const view = await renderMessaging()
    expect(await screen.findByText('Restoring messaging connections…')).toBeTruthy()
    view.rerender(<MemoryRouter><div>Desktop chat</div></MemoryRouter>)
    await act(async () => { publishOperation({ phase: 'failed', error: 'apply_failed' }) })
    expect(screen.getByText('Desktop chat')).toBeTruthy()
    expect(notify).not.toHaveBeenCalled()
    view.rerender(<MemoryRouter><MessagingView /></MemoryRouter>)
    expect(await screen.findByText('Messaging could not be restored. Desktop chat is available. Retry the connection or open logs.')).toBeTruthy()
    expect(screen.getByText('Original adapter is reconnecting')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open logs' }))
    expect(revealLogs).toHaveBeenCalledOnce()
    await act(async () => { publishOperation({ phase: 'failed', error: 'gateway_identity_unverified' }) })
    expect(await screen.findByText('The existing gateway’s ownership could not be verified. No new gateway was started. Open logs for details.')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0])
    await waitFor(() => expect(messagingSetup).toHaveBeenCalledWith({ operation: 'retry', profile: 'default' }))
  })

  it('平台确认中不展示过渡停机或需重启，完成后先同步卡片再显示成功', async () => {
    const ready = dingtalk({ configured: true, enabled: true, gateway_running: true, state: 'connected' })
    getMessagingPlatforms.mockResolvedValue({ platforms: [ready] })
    await renderMessaging()
    let oldSnapshot!: (value: { platforms: MessagingPlatformInfo[] }) => void
    let freshSnapshot!: (value: { platforms: MessagingPlatformInfo[] }) => void
    getMessagingPlatforms.mockReturnValueOnce(new Promise(resolve => { oldSnapshot = resolve }))
    await act(async () => { publishOperation({ phase: 'checking', saved: true, operation: 'save' }) })
    expect(await screen.findByText('Checking messaging platform status…')).toBeTruthy()
    getMessagingPlatforms.mockReturnValueOnce(new Promise(resolve => { freshSnapshot = resolve }))
    await act(async () => { publishOperation({ phase: 'completed' }) })
    expect(screen.queryByText('Messaging settings applied.')).toBeNull()
    await act(async () => { oldSnapshot({ platforms: [{ ...ready, state: 'pending_restart', gateway_running: false }] }) })
    const card = screen.getByRole('article', { name: 'DingTalk bot integration' })
    expect(within(card).queryByText('Messaging gateway stopped')).toBeNull()
    expect(within(card).queryByText('Restart required')).toBeNull()
    expect(screen.queryByText('Messaging settings applied.')).toBeNull()
    await act(async () => { freshSnapshot({ platforms: [ready] }) })
    expect(await screen.findByText('Messaging settings applied.')).toBeTruthy()
    expect(within(card).getByText('Connected')).toBeTruthy()
    expect(notify).not.toHaveBeenCalled()
  })

  it('保存后关闭弹窗，离开页面时任务状态继续，返回后显示失败并可重试', async () => {
    getMessagingPlatforms.mockResolvedValue({ platforms: [dingtalk({ configured: true, enabled: true, state: 'connected' })] })
    const view = await renderMessaging()
    fireEvent.click(within(await screen.findByRole('article', { name: 'DingTalk bot integration' })).getByRole('button', { name: 'Configure' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(dialog.querySelector('input[type="text"]')!, { target: { value: 'id' } })
    fireEvent.change(dialog.querySelector('input[type="password"]')!, { target: { value: 'secret' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and enable' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await act(async () => { publishOperation({ phase: 'restarting', saved: true, operation: 'save' }) })
    expect(await screen.findByText('Messaging gateway is restarting… Other chat apps will disconnect briefly.')).toBeTruthy()
    expect(within(screen.getByRole('article', { name: 'DingTalk bot integration' })).queryByText('Connected')).toBeNull()

    view.rerender(<MemoryRouter><div>Other page</div></MemoryRouter>)
    getMessagingPlatforms.mockResolvedValue({ platforms: [dingtalk({ configured: true, enabled: true, state: 'retrying' })] })
    await act(async () => { publishOperation({ phase: 'failed', saved: true, error: 'apply_failed' }) })
    expect(screen.getByText('Other page')).toBeTruthy()
    expect(screen.queryByText(/Settings saved, but/)).toBeNull()
    expect(notify).not.toHaveBeenCalled()
    view.rerender(<MemoryRouter><MessagingView /></MemoryRouter>)
    expect(await screen.findByText('Settings saved, but the messaging connection could not be restored. Retry the connection.')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0])
    await waitFor(() => expect(messagingSetup).toHaveBeenCalledWith({ operation: 'retry', profile: 'default' }))
  })

  it('解绑确认立即关闭，页面展示停止状态，旧快照不能覆盖新状态', async () => {
    let resolveSnapshot!: (status: MessagingOperationStatus) => void
    window.hermesDesktop.messagingStatus = () => new Promise(resolve => { resolveSnapshot = resolve })
    getMessagingPlatforms.mockResolvedValue({ platforms: [dingtalk({ configured: true, enabled: true, state: 'connected' })] })
    await renderMessaging()
    fireEvent.click(within(await screen.findByRole('article', { name: 'DingTalk bot integration' })).getByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await act(async () => {
      publishOperation({ phase: 'stopping', saved: true, operation: 'disconnect' })
      resolveSnapshot({ phase: 'idle', revision: 0 })
    })
    expect(await screen.findByText('Messaging gateway is stopping…')).toBeTruthy()
    expect(notify).not.toHaveBeenCalled()
    await act(async () => { publishOperation({ phase: 'completed' }) })
    expect(await screen.findByText('Messaging settings applied.')).toBeTruthy()
  })

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
      expect(messagingSetup).toHaveBeenCalledWith({
        operation: 'save',
        platform: id,
        env: { [key]: 'bot-id', [secret]: 'bot-secret' },
        profile: 'default'
      })
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

  it('shows supported cards and unavailable RCS without advanced fields or Profile controls', async () => {
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
    const pending = screen.getByRole('article', { name: /5G/ })
    expect(within(pending).getByRole('status').textContent).toBe('Messaging component unavailable')
    expect(within(pending).queryByRole('button', { name: 'Configure' })).toBeNull()
    expect(screen.queryByText('QQ Bot')).toBeNull()
    expect(screen.queryByText('WeCom Callback')).toBeNull()
    expect(screen.queryByText('Allowed users')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(updateMessagingPlatform).not.toHaveBeenCalled()
    expect(runGatewayRestart).not.toHaveBeenCalled()
    expect(startWeixinQrLogin).not.toHaveBeenCalled()
  })

  it('saves necessary credentials in the selected profile and applies automatically', async () => {
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
        expect(messagingSetup).toHaveBeenCalledWith({
          operation: 'save',
          platform: 'dingtalk',
          env: { DINGTALK_CLIENT_ID: 'app-123', DINGTALK_CLIENT_SECRET: 'secret-123' },
          profile: 'worker'
        })
      )
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(screen.queryByRole('button', { name: 'Restart now' })).toBeNull()
      expect(runGatewayRestart).not.toHaveBeenCalled()
      expect(screen.queryByText('owner-only')).toBeNull()
      expect(messagingSetup).toHaveBeenCalledTimes(1)
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
    messagingSetup.mockRejectedValueOnce(new Error('credentials_rejected'))
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
    expect(await within(dialog).findByText('Could not save messaging settings. Your previous configuration is unchanged.')).toBeTruthy()
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
        expect(messagingSetup).toHaveBeenCalledWith({
          operation: 'disconnect',
          platform: 'dingtalk',
          profile: 'worker'
        })
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

describe('MessagingView RCS integration', () => {
  it('shows 5G startup as connecting and settles in place without a gateway restart', async () => {
    const rcs = platform({ id: 'uniagentgate', configured: true, enabled: true,
      gateway_running: true, state: 'pending_restart' })

    getMessagingPlatforms.mockResolvedValue({ platforms: [rcs] })
    publishOperation({ phase: 'applying', operation: 'restore', saved: true })
    await renderMessaging()
    const card = await screen.findByRole('article', { name: /5G/ })
    expect(within(card).getByRole('status').textContent).toBe('Connecting')
    expect(within(card).queryByText('Restart required')).toBeNull()
    getMessagingPlatforms.mockResolvedValue({ platforms: [{ ...rcs, state: 'connected' }] })
    await act(async () => { publishOperation({ phase: 'completed' }) })
    await waitFor(() => expect(within(card).getByRole('status').textContent).toBe('Connected'))
    expect(messagingSetup).not.toHaveBeenCalled()
    expect(runGatewayRestart).not.toHaveBeenCalled()
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
    expect(messagingSetup).not.toHaveBeenCalled()
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


})
