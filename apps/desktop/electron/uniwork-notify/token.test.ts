import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import type { LoginIdentity } from '../login/session'

import { NtfyTokenClient, NtfyTokenError, parseNtfyToken } from './token'

const NOW = 1_800_000_000_000

function identity(overrides: Partial<LoginIdentity> = {}): LoginIdentity {
  return {
    expiresAt: NOW + 3_600_000,
    maskedPhone: '138****0000',
    phone: '13800000000',
    token: 'login-jwt',
    uid: 'u-1',
    ...overrides
  }
}

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

it('只接受带有效期与凭证的响应，不补造默认值', () => {
  expect(parseNtfyToken({ expires: 1_800_003_000, token: 'tk_1' }, NOW)).toEqual({
    expiresAt: 1_800_003_000_000,
    token: 'tk_1'
  })
  expect(parseNtfyToken({ data: { expires: 1_800_003_000, token: ' tk_2 ' } }, NOW).token).toBe('tk_2')

  for (const body of [
    null,
    {},
    { expires: 1_800_003_000 },
    { token: 'tk_1' },
    { expires: '1800003000', token: 'tk_1' },
    { expires: 1_700_000_000, token: 'tk_1' },
    { code: 401, token: 'tk_1', expires: 1_800_003_000 }
  ]) {
    expect(() => parseNtfyToken(body, NOW)).toThrow(NtfyTokenError)
  }
})

it('有效期内复用缓存凭证，换账号立即作废', async () => {
  let current = identity()
  const request = vi.fn(async () => tokenResponse({ expires: 1_800_003_000, token: 'tk_cached' }))
  const client = new NtfyTokenClient(() => current, { now: () => NOW, request })

  expect(await client.get()).toBe('tk_cached')
  expect(await client.get()).toBe('tk_cached')
  expect(request).toHaveBeenCalledTimes(1)

  current = identity({ token: 'login-jwt-2' })

  expect(await client.get()).toBe('tk_cached')
  expect(request).toHaveBeenCalledTimes(2)
})

it('临近过期就重新换取，失效响应整条重取', async () => {
  const request = vi.fn(async () => tokenResponse({ expires: 1_800_000_030, token: 'tk_short' }))
  const client = new NtfyTokenClient(() => identity(), { now: () => NOW, request })

  await client.get()
  await client.get()

  expect(request).toHaveBeenCalledTimes(2)

  request.mockClear()
  request.mockResolvedValueOnce(tokenResponse({ expires: 1_800_000_030, token: 'tk_fresh' }))
  client.invalidate()

  expect(await client.get()).toBe('tk_fresh')
})

it('换取失败按状态码分类，登录态无效时不循环重试', async () => {
  const cases: [number, string][] = [
    [401, 'auth'],
    [403, 'auth'],
    [404, 'unconfigured'],
    [429, 'throttled'],
    [500, 'network']
  ]

  for (const [status, reason] of cases) {
    const client = new NtfyTokenClient(() => identity(), {
      now: () => NOW,
      request: vi.fn(async () => tokenResponse({}, status))
    })

    await expect(client.get()).rejects.toMatchObject({ reason })
  }

  const offline = new NtfyTokenClient(() => identity(), {
    now: () => NOW,
    request: vi.fn(async () => Promise.reject(new Error('offline')))
  })

  await expect(offline.get()).rejects.toMatchObject({ reason: 'network' })
})

it('没有有效登录身份时不发请求', async () => {
  const request = vi.fn(async () => tokenResponse({ expires: 1_800_003_000, token: 'tk' }))
  const client = new NtfyTokenClient(() => ({ ...identity(), expiresAt: NOW - 1 }), { now: () => NOW, request })

  await expect(client.get()).rejects.toMatchObject({ reason: 'auth' })
  expect(request).not.toHaveBeenCalled()
})
