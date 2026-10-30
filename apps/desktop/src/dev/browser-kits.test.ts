import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesConnection } from '@/global'
import { browserKits } from './browser-kits'

const primary = { wsUrl: 'ws://example.test/hermes/api/ws', profile: 'default', connectionId: 'local' } as HermesConnection

afterEach(() => vi.unstubAllGlobals())

describe('cloud kits', () => {
  it('resolves owned profiles on the same backend and checkpoints mutations in the default scope', async () => {
    const fetch = vi.fn(async (_url: string) => Response.json({ profile: 'expert-a' }))
    vi.stubGlobal('fetch', fetch)
    const mutate = vi.fn(async () => ({ ok: true }))
    const kits = browserKits('/hermes/', primary, mutate as never)
    for (const profile of ['expert-a', 'expert-b', 'default']) {
      const result = await kits.getConnectionFor({ profile, connectionId: 'local' })
      expect(result.profile).toBe(profile)
      expect(result.sharedPrimary).toBe(true)
      expect(result.wsUrl).toBe('ws://example.test/hermes/api/ws?kits=1')
      expect(fetch.mock.calls.at(-1)?.[0]).toContain(`name=${profile}`)
    }
    await kits.request({ path: '/api/plugins/uniwork-kits/toggle', method: 'POST', profile: 'expert-a', body: { name: 'writer', enabled: false } })
    expect(mutate).toHaveBeenCalledWith({ path: '/api/plugins/uniwork-kits/cloud/action', method: 'POST', profile: 'default', body: { operation: 'toggle', name: 'writer', enabled: false } })
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('Bearer')
  })

  it('reads portraits through the current instance cloud route before installation', async () => {
    const fetch = vi.fn(async () => Response.json({ data_url: 'data:image/png;base64,Y2F0' }))
    vi.stubGlobal('fetch', fetch)
    const mutate = vi.fn()
    const kits = browserKits('/hermes/', primary, mutate as never)
    await expect(kits.request({ path: '/api/plugins/uniwork-kits/experts/douyin-strategist/avatar' }))
      .resolves.toEqual({ data_url: 'data:image/png;base64,Y2F0' })
    expect(fetch).toHaveBeenCalledWith('/hermes/__hermes_backend/api/plugins/uniwork-kits/cloud/experts/douyin-strategist/avatar?profile=default',
      { credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('refuses missing experts, other connections and arbitrary install URLs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })))
    const mutate = vi.fn()
    const kits = browserKits('/hermes/', primary, mutate as never)
    await expect(kits.getConnection('missing')).rejects.toThrow('专家')
    await expect(kits.getConnectionFor({ connectionId: 'other', profile: 'expert' })).rejects.toThrow('当前账号')
    await expect(kits.request({ path: '/api/plugins/uniwork-kits/install', method: 'POST', body: { url: 'https://external.invalid/a.zip' } })).rejects.toThrow('不支持')
    expect(mutate).not.toHaveBeenCalled()
  })
})
