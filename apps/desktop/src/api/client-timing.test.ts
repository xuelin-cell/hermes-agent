import { JsonRpcGatewayClient } from '@hermes/shared'
import { afterEach, expect, it, vi } from 'vitest'

import { HermesGateway } from './client'

// desktop-mt: 云版耗时埋点挂在每条连接的请求和事件上（lib/timing-mt.ts）
const timing = vi.hoisted(() => ({
  noteGatewayRequest: vi.fn((_gateway: object, _method: string, _params: object, request: Promise<unknown>) => request),
  watchGateway: vi.fn()
}))

vi.mock('@/lib/timing-mt', () => timing)

afterEach(() => vi.restoreAllMocks())

it('hands every connection and request to the timing hooks and returns the request untouched', async () => {
  vi.spyOn(JsonRpcGatewayClient.prototype, 'request').mockResolvedValue({ session_id: 's1' })
  const client = new HermesGateway()

  expect(timing.watchGateway).toHaveBeenCalledWith(client)

  const result = await client.request('session.create', { cols: 80 })

  expect(result).toEqual({ session_id: 's1' })
  expect(timing.noteGatewayRequest).toHaveBeenCalledWith(client, 'session.create', { cols: 80 }, expect.any(Promise))
})
