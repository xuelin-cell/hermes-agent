import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesConnection } from '@/global'
import { browserKits } from './browser-kits'
import { setRuntimeI18nLocale } from '@/i18n/runtime'

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
    setRuntimeI18nLocale('zh')
    await expect(kits.getConnection('missing')).rejects.toThrow('无权')
    await expect(kits.getConnectionFor({ connectionId: 'other', profile: 'expert' })).rejects.toThrow('当前账号')
    await expect(kits.request({ path: '/api/plugins/uniwork-kits/install', method: 'POST', body: { url: 'https://external.invalid/a.zip' } })).rejects.toThrow('不支持')
    expect(mutate).not.toHaveBeenCalled()
  })

  it.each([
    [401, {}, '重新登录'],
    [404, {}, '不存在'],
    [502, { error: 'tenant_not_ready', detail: 'CubeError' }, '尚未就绪'],
    [502, { error: 'tenant_not_ready', reason: 'sandbox_node_unhealthy' }, '节点不健康'],
    [502, { error: 'tenant_not_ready', reason: 'sandbox_permission_denied' }, '目录权限'],
    [502, { error: 'tenant_not_ready', reason: 'sandbox_operation_timeout' }, '超时'],
    [503, { error: 'database_unavailable' }, '尚未就绪']
  ])('preserves the cause of HTTP %s without exposing upstream bodies', async (status, body, expected) => {
    setRuntimeI18nLocale('zh')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...body, message: 'secret-token=private' }, { status })))
    const kits = browserKits('/hermes/', primary, vi.fn() as never)
    for (const request of [() => kits.getConnection(), () => kits.request({ path: '/api/plugins/uniwork-kits/experts' })]) {
      try { await request(); expect.fail('expected failure') } catch (error) {
        expect(String(error)).toContain(expected)
        expect(String(error)).toContain(`HTTP ${status}`)
        expect(String(error)).not.toContain('private')
        expect(String(error)).not.toContain('专家尚未安装')
      }
    }
  })

  it('keeps proxy HTML and network failures out of missing-expert errors', async () => {
    setRuntimeI18nLocale('zh')
    const fetch = vi.fn().mockResolvedValueOnce(new Response('<html>secret-token=private</html>', { status: 502 }))
      .mockRejectedValueOnce(new TypeError('fetch failed: secret-token=private'))
    vi.stubGlobal('fetch', fetch)
    const kits = browserKits('/hermes/', primary, vi.fn() as never)
    await expect(kits.getConnection()).rejects.toThrow('尚未就绪')
    await expect(kits.getConnection()).rejects.toThrow('检查网络')
  })
})
