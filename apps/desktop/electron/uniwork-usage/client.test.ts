import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: {} }))
import { PlanUsageClient } from './client'
import { normalizePlanUsage } from './contract'

it('真实 HTTP 查询白名单字段、合并请求、隔离账号缓存并拒绝迟到响应', async () => {
  let identity = { uid: 'a', token: 'token-a', maskedPhone: '138****0001', expiresAt: Date.now() + 60_000 }
  let calls = 0
  let hold = false
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const server = createServer(async (request, response) => {
    calls++
    const isA = request.headers.authorization === 'Bearer token-a'
    if (isA && hold)
      await new Promise<void>(done => {
        release = done
        started?.()
      })
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        code: 0,
        data: {
          apiKey: 'secret-key',
          models: 'secret-models',
          agentKeyPersonal: 'private-agent-key',
          productName: isA ? 'Coding' : 'Token',
          planType: isA ? 'coding_plan' : 'token_plan',
          codingPlanUsage: { second: 20, secondTtl: 60, week: null, month: 0, monthTtl: 0 },
          tokenPlanUsage: {
            totalQuota: 1000,
            usedQuota: 250,
            quotaUnit: 'credits',
            concurrencyLimit: 3,
            currentConcurrency: 1
          }
        }
      })
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const request: typeof fetch = async (url, options) => {
    expect(url).toBe('https://maas.ai-yuanjing.com/app/gateway/uniwork/my-plan')
    expect(options?.redirect).toBe('error')
    return fetch(`http://127.0.0.1:${address.port}`, options)
  }
  const client = new PlanUsageClient(() => identity, request)
  const accountA = { ...identity }
  try {
    const [first, second] = await Promise.all([client.load(), client.load()])
    expect(first).toEqual(second)
    expect(calls).toBe(1)
    expect(JSON.stringify(first)).not.toMatch(/secret|private-agent|token-a|apiKey|models/)
    if (first.status !== 'available') throw new Error('Missing data')
    expect(first.data.windows.map(window => window.name)).toEqual(['five-hour', 'month'])
    expect(first.data.windows[0]!.resetAt).toBe(first.data.fetchedAt + 60_000)
    expect(first.data.quota).toBeNull()
    identity = { ...accountA, uid: 'b', token: 'token-b', maskedPhone: '138****0002' }
    const accountB = { ...identity }
    const token = await client.load()
    if (token.status !== 'available') throw new Error('Missing token usage')
    expect(token.data.quota?.remaining).toBe(750)
    expect(token.data.windows).toEqual([])
    identity = { ...accountA }
    hold = true
    const waiting = new Promise<void>(done => {
      started = done
    })
    const late = client.load()
    await waiting
    identity = { ...accountB }
    await client.load()
    release?.()
    expect(await late).toEqual({ status: 'failed', reason: 'auth' })
    identity = { ...accountA, expiresAt: Date.now() - 1 }
    const before = calls
    expect(await client.load()).toEqual({ status: 'failed', reason: 'auth' })
    expect(calls).toBe(before)
    expect(normalizePlanUsage({ planType: 'token_plan', tokenPlanUsage: {} }, Date.now()).quota).toBeNull()
    expect(
      normalizePlanUsage({ planType: 'other', tokenPlanUsage: { totalQuota: 100, usedQuota: 0 } }, Date.now()).quota
    ).toBeNull()
  } finally {
    release?.()
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
})
