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
    await expect(bridge.request({ path: '/api/messaging/platforms/weixin', method: 'PUT', body: { enabled: true } })).rejects.toThrow('首期')
    expect(bridge.request({ path: '/api/sessions' })).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not report successful setup on an unauthorized or unconfigured entry', async () => {
    const fetcher = vi.fn(async () => new Response('集中消息接入尚未部署。', { status: 503 }))
    vi.stubGlobal('fetch', fetcher)
    const bridge = browserMessaging('/hermes/')
    await expect(bridge.reconnectUniAgentGate()).rejects.toThrow('尚未部署')
    await expect(bridge.messagingSetup({ operation: 'save', platform: 'feishu' })).rejects.toThrow('首期')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
