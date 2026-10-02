import type { CaptchaResult } from './contract'

/** 获取并校验验证码，只返回必要字段，异常正文不跨越主进程边界。 */
export async function fetchCaptcha(request: typeof fetch): Promise<CaptchaResult> {
  try {
    const response = await request('https://maas.ai-yuanjing.com/app/login/captcha', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store'
    })

    if (!response.ok) {
      return { ok: false }
    }

    const body = await response.json()

    if (!body || ![0, '0'].includes(body.code)) {
      return { ok: false }
    }

    const { captchaId, b64s } = body.data ?? {}

    if (
      typeof captchaId !== 'string' ||
      !captchaId.trim() ||
      captchaId.length > 256 ||
      typeof b64s !== 'string' ||
      b64s.length > 1_000_000 ||
      !/^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(b64s)
    ) {
      return { ok: false }
    }

    return { ok: true, captcha: { captchaId, imageDataUrl: b64s } }
  } catch {
    return { ok: false }
  }
}
