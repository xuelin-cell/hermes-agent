import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getHermesConfigRecord,
  peekConfigReadOrigin,
  saveHermesConfig,
  setApiRequestConnection,
  setApiRequestProfile,
  validateCustomEndpoint
} from '@/hermes'

describe('config read/write route binding', () => {
  let api: ReturnType<typeof vi.fn>

  beforeEach(() => {
    api = vi.fn(async (request: { method?: string }) =>
      request.method === 'PUT' ? { ok: true } : { model: 'from-read' }
    )
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { api }
    })
    setApiRequestConnection(null)
    setApiRequestProfile(null)
  })

  afterEach(() => {
    setApiRequestConnection(null)
    setApiRequestProfile(null)
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'hermesDesktop')
  })

  it('模型测试交给所属连接和 Profile 的插件读取已保存 Key，页面不补回秘密', async () => {
    setApiRequestConnection('connection-a')
    const endpoint = { id: 'personal', name: 'Personal', model: 'raw-id', base_url: 'https://models.invalid/v1' }

    await validateCustomEndpoint(endpoint, 'worker')
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'connection-a',
        profile: 'worker',
        method: 'POST',
        path: '/api/plugins/desktop-models/validate',
        body: endpoint
      })
    )
    expect(api.mock.calls[0][0].body).not.toHaveProperty('api_key')
  })

  it('config record read from A cannot be written to B after primary changes', async () => {
    setApiRequestConnection('connection-a')
    setApiRequestProfile('default')

    const record = await getHermesConfigRecord()

    expect(peekConfigReadOrigin(record)).toEqual({ connectionId: 'connection-a', profile: 'default' })
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'connection-a', path: '/api/config', profile: 'default' })
    )

    setApiRequestConnection('connection-b')
    await saveHermesConfig(record)

    const puts = api.mock.calls.filter(call => call[0].method === 'PUT')

    expect(puts).toHaveLength(1)
    expect(puts[0][0]).toEqual(
      expect.objectContaining({
        connectionId: 'connection-a',
        method: 'PUT',
        path: '/api/config',
        profile: 'default'
      })
    )
    expect(puts.filter(call => call[0].connectionId === 'connection-b')).toHaveLength(0)
  })
})
