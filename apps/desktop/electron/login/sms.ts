import type { SmsRequest, SmsResult } from './contract'

/** 校验不可信 IPC 参数，只挑选短信接口需要的三个字段。 */
function parseInput(input: unknown): SmsRequest | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const { phone, captchaCode, captchaId } = input as Partial<SmsRequest>

  if (
    typeof phone !== 'string' ||
    !/^1\d{10}$/.test(phone) ||
    typeof captchaCode !== 'string' ||
    !captchaCode.trim() ||
    captchaCode.length > 6 ||
    typeof captchaId !== 'string' ||
    !captchaId.trim() ||
    captchaId.length > 256
  ) {
    return null
  }

  return { phone, captchaCode: captchaCode.trim(), captchaId }
}

/** 解析标准 Retry-After 秒数或日期，不把上游原始正文交给页面。 */
function retryDeadline(response: Response): number | null {
  const header = response.headers.get('Retry-After')?.trim()

  if (!header) {
    return null
  }

  const value = /^\d+$/.test(header) ? Date.now() + Number(header) * 1000 : Date.parse(header)

  return Number.isSafeInteger(value) ? Math.max(Date.now(), value) : null
}

/** 在登录窗口生命周期内串行发送，成功冷却或上游限流期间拒绝再次请求。 */
export function createSmsSender(request: typeof fetch) {
  let pending = false
  let retryAt = 0

  /** 仅显式点击触发一次 POST，失败释放发送锁，绝不自动重试。 */
  return async function sendSms(input: unknown): Promise<SmsResult> {
    const body = parseInput(input)

    if (!body) {
      return { ok: false, error: 'invalid' }
    }

    if (pending) {
      return { ok: false, error: 'busy' }
    }

    if (Date.now() < retryAt) {
      return { ok: false, error: 'limited', retryAt }
    }

    pending = true

    try {
      const response = await request('https://maas.ai-yuanjing.com/app/login/sendCode', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store'
      })

      const upstreamDeadline = retryDeadline(response)

      if (response.status === 429 || (!response.ok && upstreamDeadline !== null)) {
        retryAt = upstreamDeadline ?? Date.now() + 60_000

        return { ok: false, error: 'limited', retryAt }
      }

      if (!response.ok) {
        return { ok: false, error: 'failed' }
      }

      const result = await response.json()
      const code = result?.code

      if (code !== 0 && code !== '0') {
        // 网关也会在 HTTP 200 响应中返回业务限流码。
        if (code === 429 || code === '429' || upstreamDeadline !== null) {
          retryAt = upstreamDeadline ?? Date.now() + 60_000

          return { ok: false, error: 'limited', retryAt }
        }

        if (code === 1002 || code === '1002') {
          return {
            ok: false,
            error: result.msg === '图形验证码已失效，请刷新后重试' ? 'captchaExpired' : 'captchaIncorrect'
          }
        }

        return { ok: false, error: 'failed' }
      }

      retryAt = Math.max(Date.now() + 60_000, upstreamDeadline ?? 0)

      return { ok: true, retryAt }
    } catch {
      return { ok: false, error: 'failed' }
    } finally {
      pending = false
    }
  }
}
