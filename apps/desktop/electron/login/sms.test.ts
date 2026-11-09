import { afterEach, expect, it, vi } from 'vitest'

import { createSmsSender } from './sms'

const input = { phone: '13800000000', captchaCode: 'abcd', captchaId: 'fixture-id' }
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('校验不发请求，并发只发一次；成功冷却不能通过改手机号绕过，期限后允许重发', async () => {
  vi.useFakeTimers()
  let resolve!: (response: Response) => void

  const request = vi.fn<typeof fetch>().mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )

  const send = createSmsSender(request)

  for (const value of [
    null,
    {},
    { ...input, phone: '123' },
    { ...input, captchaCode: ' ' },
    { ...input, captchaId: '' }
  ]) {
    expect(await send(value)).toEqual({ ok: false, error: 'invalid' })
  }

  expect(request).not.toHaveBeenCalled()
  const pending = send({ ...input, url: 'https://attacker.invalid', token: 'must-not-send' })
  expect(await send(input)).toEqual({ ok: false, error: 'busy' })
  expect(request).toHaveBeenCalledTimes(1)
  expect(request.mock.calls[0][0]).toBe('https://maas.ai-yuanjing.com/app/login/sendCode')
  const options = request.mock.calls[0][1]!
  expect(options).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store' })
  expect(JSON.parse(options.body as string)).toEqual(input)
  resolve(Response.json({ code: 0, token: 'private-response' }))
  const success = await pending
  expect(success).toEqual({ ok: true, retryAt: Date.now() + 60_000 })
  expect(await send({ ...input, phone: '13900000000' })).toEqual({ ...success, ok: false, error: 'limited' })
  vi.advanceTimersByTime(60_000)
  request.mockResolvedValueOnce(Response.json({ code: '0' }))
  expect((await send(input)).ok).toBe(true)
  expect(request).toHaveBeenCalledTimes(2)
})

it('失败不冷却、不重试、不泄露正文；遵守限流秒数和日期并在超时后释放锁', async () => {
  vi.useFakeTimers()
  const request = vi.fn<typeof fetch>()
  const send = createSmsSender(request)

  for (const response of [
    Response.json({ code: 9, msg: 'private-body' }),
    Response.json({}),
    new Response('bad-json'),
    new Response('private', { status: 503 })
  ]) {
    request.mockResolvedValueOnce(response)
    expect(await send(input)).toEqual({ ok: false, error: 'failed' })
  }

  expect(request).toHaveBeenCalledTimes(4)

  for (const [msg, error] of [
    ['图形验证码错误', 'captchaIncorrect'],
    ['图形验证码已失效，请刷新后重试', 'captchaExpired']
  ]) {
    request.mockResolvedValueOnce(Response.json({ code: 1002, msg, data: 'private' }))
    expect(await send(input)).toEqual({ ok: false, error })
  }

  request.mockResolvedValueOnce(Response.json({ code: 429, msg: '已经发送短信，请稍后再试' }))
  expect(await send(input)).toEqual({ ok: false, error: 'limited', retryAt: Date.now() + 60_000 })
  vi.advanceTimersByTime(60_000)

  for (const header of ['120', new Date(Date.now() + 180_000).toUTCString()]) {
    request.mockResolvedValueOnce(new Response('private', { status: 429, headers: { 'Retry-After': header } }))
    const expected = /^\d+$/.test(header) ? Date.now() + Number(header) * 1000 : Date.parse(header)
    expect(await send(input)).toEqual({ ok: false, error: 'limited', retryAt: expected })
    const count = request.mock.calls.length
    expect((await send(input)).ok).toBe(false)
    expect(request).toHaveBeenCalledTimes(count)
    vi.setSystemTime(expected)
  }

  const controller = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  request.mockImplementationOnce(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new Error('private-timeout')), { once: true })
      })
  )
  const pending = send(input)
  expect(timeout).toHaveBeenCalledWith(15_000)
  controller.abort()
  expect(await pending).toEqual({ ok: false, error: 'failed' })
  request.mockResolvedValueOnce(Response.json({ code: 0 }))
  expect((await send(input)).ok).toBe(true)
})
