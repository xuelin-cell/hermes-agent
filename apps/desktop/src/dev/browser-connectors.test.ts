import { afterEach, expect, it, vi } from 'vitest'
import { browserConnectors } from './browser-connectors'

afterEach(() => vi.unstubAllGlobals())

it('uses cookie-only fixed routes and rejects providers/profiles that are not supported', async () => {
  const fetcher = vi.fn(async () => Response.json({ connectors: [{ id: 'amap', connected: true }] }))
  vi.stubGlobal('fetch', fetcher)
  const bridge = browserConnectors('/hermes/')
  await bridge.localConnectors({ operation: 'connect', profile: 'default', id: 'amap', values: { apiKey: 'provider-key' } })
  for (const [id, values] of [
    ['youdao_note', { apiKey: 'note-key' }], ['wps_mcp', { apiKey: 'apik:test' }],
    ['wecom_bot', { botId: 'bot', secret: 'bot-secret' }], ['ima', { clientId: 'client', apiKey: 'ima-key' }]
  ] as const) {
    await bridge.localConnectors({ operation: 'connect', profile: 'default', id, values })
  }
  expect(fetcher).toHaveBeenCalledWith('/hermes/__entry/connectors', expect.objectContaining({ credentials: 'same-origin', method: 'POST', redirect: 'error' }))
  expect(new Headers((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers).has('Authorization')).toBe(false)
  for (const input of [
    { operation: 'connect', profile: 'other', id: 'amap' },
    { operation: 'authorize', profile: 'default', id: 'eastmoney_mcp' },
    { operation: 'qr.start', profile: 'default', id: 'wecom_bot' }
  ] as const) {
    await expect(bridge.localConnectors(input)).rejects.toThrow('尚未')
  }
  expect(fetcher).toHaveBeenCalledTimes(5)
})

it('surfaces unconfirmed persistence without retrying the mutation', async () => {
  const fetcher = vi.fn(async () => Response.json({ error: '持久化未确认，请查询状态' }, { status: 409 }))
  vi.stubGlobal('fetch', fetcher)
  await expect(browserConnectors('/hermes/').localConnectors({ operation: 'disable', profile: 'default', id: 'amap' })).rejects.toThrow('持久化未确认')
  expect(fetcher).toHaveBeenCalledOnce()
})
