import { createCipheriv, createHash } from 'node:crypto'

const AES_KEY = Buffer.from('pCqYxNpbUS4ykGyP', 'utf8')
const AES_IV = Buffer.from('wNSOYIB1k1DjY5lA', 'utf8')
const APP_ID = 'smart-home-service'
const SECRET_KEY = '5d53df71a3694d86908c509cb0975011'
const EXCLUSIVE_URL = 'https://zeus.mail.wo.cn/openapi/mail/exclusive/set'

function encryptedMobile(phone: string): string {
  const cipher = createCipheriv('aes-128-cbc', AES_KEY, AES_IV)

  return Buffer.concat([cipher.update(phone, 'utf8'), cipher.final()]).toString('base64')
}

export async function fetchWoMailExclusiveCode(phone: string): Promise<string> {
  if (!/^1\d{10}$/.test(phone)) {
    throw new Error('请先登录有效的手机号账号。')
  }

  const body = JSON.stringify({ exclusiveName: 'app', mobile: encryptedMobile(phone) })

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const sign = createHash('md5')
      .update(`appId=${APP_ID}&body=${body}&secretKey=${SECRET_KEY}&timestamp=${timestamp}`)
      .digest('hex')
    const response = await fetch(`${EXCLUSIVE_URL}?appId=${APP_ID}`, {
      body,
      headers: { 'Content-Type': 'application/json', sign, timestamp },
      method: 'POST',
      signal: AbortSignal.timeout(15_000)
    })

    if (!response.ok) {
      throw new Error('沃邮箱授权服务暂时不可用。')
    }

    const data = (await response.json().catch(() => null)) as null | Record<string, unknown>
    const code = data && typeof data.exclusiveCode === 'string' ? data.exclusiveCode.trim() : ''

    if (code) {
      return code
    }

    if (attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 1100))
    }
  }

  throw new Error('沃邮箱没有返回有效的专属密码。')
}
