import { once } from 'node:events'
import { createServer } from 'node:http'
import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: {} }))
import type { LoginIdentity } from '../login/session'
import { buildSubscriptionMarketUrl, PlanSubscriptionClient } from './subscription'

it('每次订阅换取一次性凭证，校验身份与字段后只在主进程拼接市场地址', async () => {
  let identity: LoginIdentity = {
    uid: 'a',
    token: 'token-a',
    phone: '13800000000',
    maskedPhone: '138****0000',
    expiresAt: Date.now() + 60_000
  }
  let calls = 0
  let mode: 'ok' | '401' | 'bad' = 'ok'
  let hold = false
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const server = createServer(async (request, response) => {
    calls++
    if (mode === '401') {
      response.statusCode = 401
      response.end()
      return
    }
    if (hold)
      await new Promise<void>(done => {
        release = done
        started?.()
      })
    response.setHeader('Content-Type', 'application/json')
    response.end(
      mode === 'bad'
        ? JSON.stringify({ ticket: 'incomplete' })
        : JSON.stringify({
            ticket: `ticket-${calls}`,
            customerId: 'customer-1',
            timestamp: '1700000000',
            number: 'order-1',
            apiKey: 'secret-key'
          })
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const request: typeof fetch = async (url, options) => {
    expect(url).toBe('https://maas.ai-yuanjing.com/app/gateway/uniwork/market-ticket')
    expect(options?.redirect).toBe('error')
    return fetch(`http://127.0.0.1:${address.port}`, options)
  }
  const openExternal = vi.fn(async (_url: string) => ({ ok: true }))
  const client = new PlanSubscriptionClient(() => identity, openExternal, request)

  try {
    expect(await client.open()).toEqual({ status: 'opened' })
    expect(await client.open()).toEqual({ status: 'opened' })
    expect(calls).toBe(2)
    expect(openExternal).toHaveBeenCalledTimes(2)
    const first = openExternal.mock.calls[0]![0] as string
    expect(first).toBe(
      buildSubscriptionMarketUrl('13800000000', {
        ticket: 'ticket-1',
        customerId: 'customer-1',
        timestamp: '1700000000',
        number: 'order-1'
      })
    )
    expect(first).not.toContain('secret-key')
    expect(first).not.toContain('token-a')
    expect(first).not.toContain('13800000000')

    identity = { ...identity, phone: undefined }
    const beforeMissingPhone = openExternal.mock.calls.length
    expect(await client.open()).toEqual({ status: 'failed', reason: 'missing-phone' })
    expect(openExternal).toHaveBeenCalledTimes(beforeMissingPhone)
    expect(calls).toBe(2)

    identity = { ...identity, phone: '13800000000', expiresAt: Date.now() - 1 }
    expect(await client.open()).toEqual({ status: 'failed', reason: 'auth' })
    expect(calls).toBe(2)

    identity = { ...identity, expiresAt: Date.now() + 60_000 }
    mode = '401'
    expect(await client.open()).toEqual({ status: 'failed', reason: 'auth' })
    mode = 'bad'
    expect(await client.open()).toEqual({ status: 'failed', reason: 'upstream' })

    mode = 'ok'
    hold = true
    const waiting = new Promise<void>(done => {
      started = done
    })
    const openedBeforeLate = openExternal.mock.calls.length
    const late = client.open()
    await waiting
    identity = { ...identity, uid: 'b', token: 'token-b' }
    release?.()
    expect(await late).toEqual({ status: 'failed', reason: 'auth' })
    expect(openExternal).toHaveBeenCalledTimes(openedBeforeLate)
  } finally {
    release?.()
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
})
