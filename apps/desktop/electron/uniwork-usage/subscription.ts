import { net } from 'electron'

import type { LoginIdentity } from '../login/session'

import type { MarketTicket, PlanSubscriptionResult } from './contract'

const MARKET_TICKET_URL = 'https://maas.ai-yuanjing.com/app/gateway/uniwork/market-ticket'
const SUBSCRIPTION_MARKET_URL = 'https://market.ai-yuanjing.com/#/active'
const PAYMENT_CALLBACK_URL = 'https://maas.ai-yuanjing.com/app/gateway/op/payment/callback'

/** 按市场协议保留原字段顺序和编码，签名参数不做任何改写。 */
export function buildSubscriptionMarketUrl(phone: string, ticket: MarketTicket): string {
  return (
    SUBSCRIPTION_MARKET_URL +
    `?u=${Buffer.from(phone, 'utf8').toString('base64')}` +
    `&callback_url=${Buffer.from(PAYMENT_CALLBACK_URL, 'utf8').toString('base64')}` +
    '&single=1' +
    `&ticket=${encodeURIComponent(ticket.ticket)}` +
    `&customerid=${encodeURIComponent(ticket.customerId)}` +
    `&timestamp=${encodeURIComponent(ticket.timestamp)}` +
    `&number=${encodeURIComponent(ticket.number)}`
  )
}

/** 只接受四个非空签名参数，拒绝数组、包裹层和超长字段。 */
function parseMarketTicket(body: unknown): MarketTicket | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }
  const data = body as Record<string, unknown>
  const value = (key: string): string | null => {
    const field = data[key]
    return typeof field === 'string' && field.trim() && field.length <= 4096 ? field : null
  }
  const ticket = value('ticket')
  const customerId = value('customerId')
  const timestamp = value('timestamp')
  const number = value('number')

  return ticket && customerId && timestamp && number ? { ticket, customerId, timestamp, number } : null
}

/** 每次点击都换取一次性凭证；完整手机号和 ticket 只在主进程内拼接并交给系统浏览器。 */
export class PlanSubscriptionClient {
  constructor(
    private readonly identity: () => LoginIdentity | null,
    private readonly openExternal: (url: string) => Promise<unknown>,
    private readonly request: typeof fetch = (input, options) => net.fetch(input, options)
  ) {}

  async open(): Promise<PlanSubscriptionResult> {
    const identity = this.identity()

    if (!identity || identity.expiresAt <= Date.now()) {
      return { status: 'failed', reason: 'auth' }
    }

    const phone = identity.phone?.trim() ?? ''

    if (!/^1\d{10}$/.test(phone)) {
      return { status: 'failed', reason: 'missing-phone' }
    }

    try {
      const response = await this.request(MARKET_TICKET_URL, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${identity.token}` },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store'
      })

      if (response.status === 401 || response.status === 403) {
        return { status: 'failed', reason: 'auth' }
      }

      if (!response.ok) {
        return { status: 'failed', reason: 'upstream' }
      }

      const ticket = parseMarketTicket(await response.json())

      if (!ticket) {
        return { status: 'failed', reason: 'upstream' }
      }

      const current = this.identity()

      if (
        !current ||
        current.uid !== identity.uid ||
        current.token !== identity.token ||
        current.expiresAt <= Date.now()
      ) {
        return { status: 'failed', reason: 'auth' }
      }

      await this.openExternal(buildSubscriptionMarketUrl(phone, ticket))

      return { status: 'opened' }
    } catch {
      return { status: 'failed', reason: 'upstream' }
    }
  }
}
