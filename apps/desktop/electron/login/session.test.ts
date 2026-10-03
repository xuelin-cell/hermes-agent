import { afterEach, expect, it, vi } from 'vitest'

import { MAAS_IDENTITY_NAMESPACE } from './credential-store'
import { LoginSession } from './session'

const input = { phone: '13800000000', smsCode: '123456' }
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('只接受完整可信字段与未来期限，UID 不丢精度，失败始终没有身份', async () => {
  const payload = { uid: 'fixture-uid', token: 'private-token', expiresAt: Date.now() + 60_000 }
  const request = vi.fn<typeof fetch>()
  const save = vi.fn()
  const session = new LoginSession(request, { save, load: vi.fn() })

  for (const invalid of [null, {}, { ...input, phone: '123' }, { ...input, smsCode: '123' }]) {
    expect(await session.login(invalid)).toEqual({ ok: false })
  }

  expect(request).not.toHaveBeenCalled()

  for (const body of [
    null,
    {},
    { code: 7, data: payload },
    { code: null, data: payload },
    ...[
      { uid: '' },
      { uid: Number.MAX_SAFE_INTEGER + 1 },
      { uid: {} },
      { token: '' },
      { expiresAt: undefined },
      { expiresAt: Date.now() - 1 },
      { expiresAt: Math.floor(Date.now() / 1000) },
      { expiresAt: 'tomorrow' },
      { expiresAt: undefined, expireIn: -1 }
    ].map(change => ({ code: 0, data: { ...payload, ...change } }))
  ]) {
    request.mockResolvedValueOnce(Response.json(body))
    expect(await session.login(input)).toEqual({ ok: false })
    expect(session.currentIdentity()).toBeNull()
  }

  request.mockResolvedValueOnce(new Response('private-body', { status: 401 }))
  expect(await session.login(input)).toEqual({ ok: false })
  request.mockResolvedValueOnce(new Response('bad-json'))
  expect(await session.login(input)).toEqual({ ok: false })
  request.mockRejectedValueOnce(new Error('private-network-body'))
  expect(await session.login(input)).toEqual({ ok: false })
  expect(session.currentIdentity()).toBeNull()
  expect(save).not.toHaveBeenCalled()
  request.mockResolvedValueOnce(Response.json({ code: 0, data: payload }))
  const result = await session.login({ ...input, uid: 'forged', token: 'forged', application: 'forged' })
  expect(result).toEqual({ ok: true, account: { maskedPhone: '138****0000', expiresAt: payload.expiresAt } })
  expect(session.currentIdentity()).toEqual({ ...payload, maskedPhone: '138****0000' })
  expect(save).toHaveBeenCalledExactlyOnceWith(session.currentIdentity())
  const [url, options] = request.mock.calls.at(-1)!
  expect(url).toBe('https://maas.ai-yuanjing.com/app/login/smsLogin')
  expect(JSON.parse(options!.body as string)).toEqual({ ...input, origin: 'app', application: 'uniwork' })
  expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' })
})

it('并发只消费一次验证码；有效身份复用、过期清除，关闭时取消且迟到响应不能恢复', async () => {
  vi.useFakeTimers()
  let resolve!: (response: Response) => void

  const request = vi.fn<typeof fetch>().mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )

  const save = vi.fn()
  const session = new LoginSession(request, { save, load: vi.fn() })
  const pending = session.login(input)
  expect(session.restore()).toEqual({ ok: false })
  expect(await session.login(input)).toEqual({ ok: false })
  expect(request).toHaveBeenCalledTimes(1)
  resolve(Response.json({ code: '0', data: { uid: 123, token: 'private-token', expireIn: 60 } }))
  const result = await pending
  expect(result).toEqual({ ok: true, account: { maskedPhone: '138****0000', expiresAt: Date.now() + 60_000 } })
  expect(session.currentIdentity()?.uid).toBe('123')
  expect(await session.login(input)).toEqual(result)
  expect(request).toHaveBeenCalledTimes(1)
  expect(save).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(60_000)
  expect(session.currentIdentity()).toBeNull()
  request.mockResolvedValueOnce(Response.json({ uid: 'uid', token: 'private-token', expires_in: 60 }))
  expect((await session.login(input)).ok).toBe(true)
  vi.advanceTimersByTime(60_000)
  request.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const late = session.login(input)
  session.dispose()
  expect(request.mock.calls.at(-1)![1]!.signal!.aborted).toBe(true)
  resolve(Response.json({ code: 0, data: { uid: 'late', token: 'late-token', expireIn: 60 } }))
  expect(await late).toEqual({ ok: false })
  expect(save).toHaveBeenCalledTimes(2)
  expect(session.currentIdentity()).toBeNull()
  expect(await session.login(input)).toEqual({ ok: false })
})

it('持久化失败不完成登录，不暴露存储错误；再次提交成功后才建立身份', async () => {
  const payload = { uid: 'fixture-uid', token: 'private-token', expireIn: 60 }
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ code: 0, data: payload }))

  const save = vi.fn().mockImplementationOnce(() => {
    throw new Error('private-storage-detail')
  })

  const session = new LoginSession(request, { save, load: vi.fn() })
  expect(await session.login(input)).toEqual({ ok: false })
  expect(session.currentIdentity()).toBeNull()
  expect((await session.login(input)).ok).toBe(true)
  expect(save).toHaveBeenCalledTimes(2)
  expect(session.currentIdentity()?.uid).toBe(payload.uid)
})

it('恢复原 UID、token 和原期限，不发网络请求；重复读取不续期，关闭后不再恢复', () => {
  vi.useFakeTimers()

  const record = {
    namespace: MAAS_IDENTITY_NAMESPACE,
    uid: 'saved-uid',
    token: 'saved-token',
    expiresAt: Date.now() + 60_000,
    maskedPhone: '138****0000'
  }

  const credentials = { save: vi.fn(), load: vi.fn().mockReturnValue(record) }
  const request = vi.fn<typeof fetch>()
  const session = new LoginSession(request, credentials)
  expect(session.restore()).toEqual({
    ok: true,
    account: { maskedPhone: record.maskedPhone, expiresAt: record.expiresAt }
  })
  expect(session.currentIdentity()).toEqual({
    uid: record.uid,
    token: record.token,
    expiresAt: record.expiresAt,
    maskedPhone: record.maskedPhone
  })
  vi.advanceTimersByTime(30_000)
  expect(session.restore()).toEqual({
    ok: true,
    account: { maskedPhone: record.maskedPhone, expiresAt: record.expiresAt }
  })
  expect(credentials.load).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(30_000)
  expect(session.restore()).toEqual({ ok: false })
  expect(session.currentIdentity()).toBeNull()
  const calls = credentials.load.mock.calls.length
  session.dispose()
  expect(session.restore()).toEqual({ ok: false })
  expect(credentials.load).toHaveBeenCalledTimes(calls)
  expect(request).not.toHaveBeenCalled()
  expect(credentials.save).not.toHaveBeenCalled()
})

it('无记录、解密失败和到期记录均要求重新登录，不改写存储或调用上游', () => {
  const credentials = { save: vi.fn(), load: vi.fn() }
  const request = vi.fn<typeof fetch>()
  const session = new LoginSession(request, credentials)
  credentials.load.mockReturnValueOnce(null)
  expect(session.restore()).toEqual({ ok: false })
  credentials.load.mockImplementationOnce(() => {
    throw new Error('private-decryption-detail')
  })
  expect(session.restore()).toEqual({ ok: false })
  credentials.load.mockReturnValueOnce({
    namespace: MAAS_IDENTITY_NAMESPACE,
    uid: 'uid',
    token: 'token',
    expiresAt: Date.now() - 1,
    maskedPhone: '138****0000'
  })
  expect(session.restore()).toEqual({ ok: false })
  expect(session.currentIdentity()).toBeNull()
  expect(credentials.save).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
})
