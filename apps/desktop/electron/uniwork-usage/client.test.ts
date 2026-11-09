import { EventEmitter, once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: {} }))
import { MAAS_IDENTITY_NAMESPACE } from '../login/credential-store'
import { LoginSession } from '../login/session'
import { createPlanRefresher } from '../uniwork-notify/refresher'

import { PlanUsageClient } from './client'
import { normalizePlanUsage } from './contract'

it('真实 HTTP 查询白名单字段、合并请求、隔离账号缓存并拒绝迟到响应', async () => {
  let identity = { uid: 'a', token: 'token-a', maskedPhone: '138****0001', expiresAt: Date.now() + 60_000 }
  let calls = 0
  const quotaUnit = '元景积分'
  let hold = false
  let release: (() => void) | undefined
  let started: (() => void) | undefined

  const server = createServer(async (request, response) => {
    calls++
    const isA = request.headers.authorization === 'Bearer token-a'

    if (isA && hold)
      {await new Promise<void>(done => {
        release = done
        started?.()
      })}

    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        code: 0,
        data: {
          apiKey: 'secret-key',
          models: 'secret-models',
          agentKeyPersonal: 'private-agent-key',
          ipUrl: 'https://gateway.invalid',
          agentIdPersonal: isA ? 'agent-a' : 'agent-b',
          productName: isA ? 'Coding' : 'Token',
          planType: isA ? 'coding_plan' : 'token_plan',
          codingPlanUsage: { second: 20, secondTtl: 60, week: null, month: 0, monthTtl: 0 },
          tokenPlanUsage: {
            totalQuota: 1000,
            usedQuota: 250,
            quotaUnit,
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

  const applyBinding = vi.fn(async () => undefined)
  const client = new PlanUsageClient(() => identity, request, applyBinding)
  const accountA = { ...identity }

  try {
    const [first, second] = await Promise.all([client.load(), client.load()])
    expect(first).toEqual(second)
    expect(calls).toBe(1)
    expect(applyBinding).toHaveBeenCalledOnce()
    expect(applyBinding).toHaveBeenLastCalledWith({ status: 'available', binding: {
      gatewayUrl: 'https://gateway.invalid', agentId: 'agent-a', agentSk: 'private-agent-key'
    } })
    expect(JSON.stringify(first)).not.toMatch(/secret|private-agent|token-a|apiKey|models/)

    if (first.status !== 'available') {throw new Error('Missing data')}
    expect(first.data.windows.map(window => window.name)).toEqual(['five-hour', 'month'])
    expect(first.data.windows[0]!.resetAt).toBe(first.data.fetchedAt + 60_000)
    expect(first.data.quota).toBeNull()
    identity = { ...accountA, uid: 'b', token: 'token-b', maskedPhone: '138****0002' }
    const accountB = { ...identity }
    const token = await client.load()

    if (token.status !== 'available') {throw new Error('Missing token usage')}
    expect(token.data.quota?.remaining).toBe(750)
    expect(token.data.quota?.unit).toBe(quotaUnit)
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
    const appliedBeforeLateResponse = applyBinding.mock.calls.length
    release?.()
    expect(await late).toEqual({ status: 'failed', reason: 'auth' })
    expect(applyBinding.mock.calls).toHaveLength(appliedBeforeLateResponse)
    hold = false
    identity = { ...accountA, expiresAt: Date.now() - 1 }
    const before = calls
    expect((await client.load()).status).toBe('available')
    expect(calls).toBe(before + 1)

    identity = { ...accountA }
    expect((await client.load()).status).toBe('available')
    const cachedCalls = calls
    expect((await client.load()).status).toBe('available')
    expect(calls).toBe(cachedCalls)
    expect((await client.load(true)).status).toBe('available')
    expect(calls).toBe(cachedCalls + 1)

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

it('套餐推送用一次 my-plan 替换已有缓存，迟到的用量查询不能覆盖新套餐', async () => {
  const identity = { uid: 'a', token: 'token-a', maskedPhone: '138****0001', expiresAt: Date.now() - 60_000 }
  const home = await mkdtemp(join(tmpdir(), 'hermes-plan-refresh-'))
  const oldQuery = new EventEmitter()
  const oldQueryStarted = once(oldQuery, 'started')
  const releaseOldQuery = once(oldQuery, 'release')
  let calls = 0

  const server = createServer(async (_request, response) => {
    const requestNumber = ++calls

    if (requestNumber === 2) {
      oldQuery.emit('started')
      await releaseOldQuery
    }

    const updated = requestNumber >= 3
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({
      apiKey: 'private-model-key',
      models: { models: [{ id: 'model', model: 'model', base_url: 'https://models.invalid' }] },
      productName: updated ? '新套餐' : '旧套餐',
      planType: 'token_plan',
      tokenPlanUsage: { totalQuota: 1000, usedQuota: updated ? 600 : 250 }
    }))
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  const request: typeof fetch = (_url, options) => fetch(`http://127.0.0.1:${port}`, options)

  const login = new LoginSession(request, {
    load: () => ({ ...identity, namespace: MAAS_IDENTITY_NAMESPACE }),
    save: vi.fn()
  })

  login.restore()
  const client = new PlanUsageClient(() => login.currentIdentity(), request)

  const refresh = createPlanRefresher(
    () => login,
    () => home,
    vi.fn(),
    (account, usage) => client.remember(account, usage)
  )

  try {
    expect(await client.load()).toMatchObject({ data: { productName: '旧套餐' } })
    const older = client.load(true)
    await oldQueryStarted

    expect(await refresh()).toEqual({ status: 'ok' })
    const latest = await client.load()
    expect(latest).toMatchObject({ data: { productName: '新套餐', quota: { used: 600 } } })
    expect(JSON.stringify(latest)).not.toContain('private-model-key')
    expect(calls).toBe(3)

    oldQuery.emit('release')
    expect(await older).toEqual(latest)
    expect(await client.load()).toEqual(latest)
    expect(calls).toBe(3)
  } finally {
    login.dispose()
    oldQuery.emit('release')
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    await rm(home, { recursive: true, force: true })
  }
})
