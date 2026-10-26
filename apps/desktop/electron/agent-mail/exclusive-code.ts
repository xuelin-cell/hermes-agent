import { createCipheriv, createHash } from 'node:crypto'

const AES_KEY = Buffer.from('pCqYxNpbUS4ykGyP', 'utf8')
const AES_IV = Buffer.from('wNSOYIB1k1DjY5lA', 'utf8')
const APP_ID = 'smart-home-service'
const SECRET_KEY = '5d53df71a3694d86908c509cb0975011'
const EXCLUSIVE_URL = 'https://zeus.mail.wo.cn/openapi/mail/exclusive/set'

function maskedPhone(phone: string): string {
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`
}

function encryptedMobile(phone: string): string {
  const cipher = createCipheriv('aes-128-cbc', AES_KEY, AES_IV)

  return Buffer.concat([cipher.update(phone, 'utf8'), cipher.final()]).toString('base64')
}

export async function fetchWoMailExclusiveCode(
  phone: string,
  request: typeof fetch = fetch,
  log: (message: string) => void = message => console.info(message)
): Promise<string> {
  if (!/^1\d{10}$/.test(phone)) {
    throw new Error('请先登录有效的手机号账号。')
  }

  const body = JSON.stringify({ exclusiveName: 'app', mobile: encryptedMobile(phone) })

  for (let attempt = 0; attempt < 3; attempt += 1) {
    log(`[agent-mail] exclusive-code request started phone=${maskedPhone(phone)} attempt=${attempt + 1}/3`)
    const timestamp = String(Math.floor(Date.now() / 1000))

    const sign = createHash('md5')
      .update(`appId=${APP_ID}&body=${body}&secretKey=${SECRET_KEY}&timestamp=${timestamp}`)
      .digest('hex')

    let response: Response

    try {
      response = await request(`${EXCLUSIVE_URL}?appId=${APP_ID}`, {
        body,
        headers: { 'Content-Type': 'application/json', sign, timestamp },
        method: 'POST',
        signal: AbortSignal.timeout(15_000)
      })
    } catch (error) {
      log(
        `[agent-mail] exclusive-code request failed phone=${maskedPhone(phone)} attempt=${attempt + 1}/3 error=${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    }

    if (!response.ok) {
      log(`[agent-mail] exclusive-code HTTP rejection phone=${maskedPhone(phone)} status=${response.status}`)
      throw new Error('沃邮箱授权服务暂时不可用。')
    }

    const data = (await response.json().catch(() => null)) as null | Record<string, unknown>

    if (data && data.code !== undefined && data.code !== '200' && data.code !== 200) {
      log(`[agent-mail] exclusive-code business rejection phone=${maskedPhone(phone)} code=${String(data.code)}`)
      throw new Error(typeof data.message === 'string' && data.message.trim() ? data.message : '沃邮箱授权失败。')
    }

    const payload = data?.data

    const code =
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      typeof (payload as Record<string, unknown>).exclusiveCode === 'string'
        ? String((payload as Record<string, unknown>).exclusiveCode).trim()
        : ''

    if (code) {
      log(`[agent-mail] exclusive-code request succeeded phone=${maskedPhone(phone)} attempt=${attempt + 1}/3`)
      return code
    }

    if (attempt < 2) {
      log(`[agent-mail] exclusive-code response had no code; retrying phone=${maskedPhone(phone)} attempt=${attempt + 1}/3`)
      await new Promise(resolve => setTimeout(resolve, 1100))
    }
  }

  throw new Error('沃邮箱没有返回有效的专属密码。')
}
