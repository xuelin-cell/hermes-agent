import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserMessaging } from './browser-messaging'

afterEach(() => vi.unstubAllGlobals())

describe('cloud messaging bridge', () => {
  it('uses cookie-only entry routes and blocks direct or unsupported platform mutations', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ platforms: [], status: 'connecting' })))
    vi.stubGlobal('fetch', fetcher)
    localStorage.setItem('maas-token', 'must-not-forward')
    const bridge = browserMessaging('/hermes/')
    await bridge.request({ path: '/api/plugins/desktop-messaging/platforms' })
    await bridge.reconnectUniAgentGate()
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      '/hermes/__entry/messaging/platforms', '/hermes/__entry/messaging/reconnect'
    ])
    for (const call of fetcher.mock.calls) {
      expect(call[1]).toMatchObject({ credentials: 'same-origin', method: 'POST' })
      expect(new Headers(call[1]?.headers).has('Authorization')).toBe(false)
    }
    await expect(bridge.request({ path: '/api/messaging/platforms/weixin', method: 'PUT', body: { enabled: true } })).rejects.toThrow('尚未')
    expect(bridge.request({ path: '/api/sessions' })).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('saves DingTalk through entry and scopes status to the current operation', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ accepted: true, phase: 'checking' })))
    vi.stubGlobal('fetch', fetcher)
    const bridge = browserMessaging('/hermes/')
    await bridge.messagingSetup({ operation: 'save', platform: 'dingtalk', env: { DINGTALK_CLIENT_ID: 'app', DINGTALK_CLIENT_SECRET: 'secret' } })
    expect(fetcher.mock.calls[0]?.[0]).toBe('/hermes/__entry/messaging/save')
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ platform: 'dingtalk', operation: 'save' })
    const snapshot = await bridge.messagingStatus()
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ platform: 'dingtalk' })
    expect(snapshot.revision).toBe(1)
  })

  it('does not report successful setup on an unauthorized or unconfigured entry', async () => {
    const fetcher = vi.fn(async () => new Response('集中消息接入尚未部署。', { status: 503 }))
    vi.stubGlobal('fetch', fetcher)
    const bridge = browserMessaging('/hermes/')
    await expect(bridge.reconnectUniAgentGate()).rejects.toThrow('尚未部署')
    await expect(bridge.messagingSetup({ operation: 'save', platform: 'feishu', profile: 'other' })).rejects.toThrow('尚未')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

it('routes Weixin QR APIs to entry and saves WeCom credentials through the same bridge', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ state: 'wait' })))
  vi.stubGlobal('fetch', fetcher)
  const bridge = browserMessaging('/hermes/')
  await bridge.request({ path: '/api/plugins/weixin-qr/login/start?profile=default', method: 'POST', body: {} })
  await bridge.request({ path: '/api/plugins/weixin-qr/login/session-1?profile=default' })
  await bridge.request({ path: '/api/plugins/weixin-qr/unbind', method: 'POST' })
  await bridge.messagingSetup({ operation: 'save', platform: 'wecom', env: { WECOM_BOT_ID: 'bot', WECOM_SECRET: 'secret' } })
  expect(fetcher.mock.calls.map(call => call[0])).toEqual([
    '/hermes/__entry/messaging/weixin-start', '/hermes/__entry/messaging/weixin-status',
    '/hermes/__entry/messaging/weixin-unbind', '/hermes/__entry/messaging/save'
  ])
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ platform: 'weixin', session_id: 'session-1' })
  expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toMatchObject({ platform: 'wecom', env: { WECOM_BOT_ID: 'bot', WECOM_SECRET: 'secret' } })
  await expect(bridge.request({ path: '/api/plugins/weixin-qr/login/start?profile=other', method: 'POST' })).rejects.toThrow('默认实例')
  expect(fetcher).toHaveBeenCalledTimes(4)
})
