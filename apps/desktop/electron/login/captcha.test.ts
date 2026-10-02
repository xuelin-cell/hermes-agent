import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchCaptcha } from './captcha'

const payload = { captchaId: 'test-id', b64s: 'data:image/png;base64,aGVsbG8=' }

afterEach(() => vi.restoreAllMocks())

describe('验证码请求', () => {
  it('固定上游与超时，只接受成功业务状态和受限图片格式', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: 0, data: payload, token: 'must-not-return' }))

    expect(await fetchCaptcha(request)).toEqual({
      ok: true,
      captcha: { captchaId: payload.captchaId, imageDataUrl: payload.b64s }
    })
    expect(request.mock.calls[0][0]).toBe('https://maas.ai-yuanjing.com/app/login/captcha')
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' })

    for (const body of [
      null,
      {},
      { code: 9, data: payload },
      { code: 0, data: {} },
      { code: 0, data: { ...payload, captchaId: ' ' } },
      { code: 0, data: { ...payload, b64s: 'https://example.invalid/image' } },
      { code: 0, data: { ...payload, b64s: 'data:image/svg+xml;base64,aGVsbG8=' } }
    ]) {
      request.mockResolvedValueOnce(Response.json(body))
      expect(await fetchCaptcha(request)).toEqual({ ok: false })
    }

    request.mockResolvedValueOnce(new Response('private body', { status: 503 }))
    expect(await fetchCaptcha(request)).toEqual({ ok: false })
    request.mockResolvedValueOnce(new Response('not-json'))
    expect(await fetchCaptcha(request)).toEqual({ ok: false })
  })

  it('超时中止请求，网络失败后下一次请求仍可成功且不回传异常正文', async () => {
    const signal = AbortSignal.timeout(20)
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal)

    const request = vi.fn<typeof fetch>().mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () => reject(new Error('private-timeout-body')), { once: true })
        })
    )

    expect(await fetchCaptcha(request)).toEqual({ ok: false })
    expect(timeout).toHaveBeenCalledWith(15_000)
    request.mockRejectedValueOnce(new Error('private-network-body'))
    expect(await fetchCaptcha(request)).toEqual({ ok: false })
    request.mockResolvedValueOnce(Response.json({ code: '0', data: payload }))
    expect((await fetchCaptcha(request)).ok).toBe(true)
  })
})
