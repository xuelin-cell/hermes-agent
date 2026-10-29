import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getRuntimeI18nLocale, setRuntimeI18nLocale } from '@/i18n/runtime'

import {
  $enterpriseShell,
  enterpriseErrorCard,
  enterpriseRecoveryPlan,
  isPlatformMcpServer,
  noteEntryAccount,
  platformRefusalReason,
  skipsTopUpPrompt
} from './enterprise-mt'
import { errorRecoveryPlan, type ErrorSurface } from './error-surface'

// What the enterprise platform answers (uniwork_admin/llm_proxy.py), as the failed turn reached the page in the
// local cloud stack (platform d79ebd7e): hermes words it `[<code>: ]HTTP <status>: <the body's message>`.
const CONTENT_FILTER =
  'content_policy_blocked: HTTP 400: 内容涉及敏感信息，已被拦截（content_filter）：Input data may contain inappropriate content.'

const QUOTA = 'HTTP 402: 你本周期的额度（1 积分）已用完，请联系管理员调整'
// A raw body as the OpenAI SDK prints it: Python repr or JSON.
const SUSPENDED = "Error code: 403 - {'error': {'message': '你已被企业停用，请联系管理员', 'code': 'member_disabled'}}"
const CARD = { body: 'hermes 的说明', title: 'hermes 的标题' }

const surface = (layer: ErrorSurface['layer'], code: string, extra: Partial<ErrorSurface> = {}): ErrorSurface => ({
  code,
  layer,
  retryable: false,
  ...extra
})

let locale = getRuntimeI18nLocale()

beforeEach(() => {
  locale = getRuntimeI18nLocale()
  setRuntimeI18nLocale('zh')
})

afterEach(() => {
  setRuntimeI18nLocale(locale)
  $enterpriseShell.set(false)
})

describe('platformRefusalReason', () => {
  it.each([
    [CONTENT_FILTER, '内容涉及敏感信息，已被拦截（content_filter）：Input data may contain inappropriate content.'],
    [QUOTA, '你本周期的额度（1 积分）已用完，请联系管理员调整'],
    [SUSPENDED, '你已被企业停用，请联系管理员'],
    ['HTTP 403: {"error": {"message": "这个 Agent 不能用这个模型", "code": "forbidden"}}', '这个 Agent 不能用这个模型'],
    // JSON with \u escapes, and a Python repr that switched to double quotes around a single quote
    ['{"error": {"message": "\\u989d\\u5ea6\\u5df2\\u7528\\u5b8c"}}', '额度已用完'],
    [`Error code: 403 - {'error': {'message': "成员'联调成员B'已停用"}}`, "成员'联调成员B'已停用"]
  ])('takes the platform sentence out of %s', (text, reason) => {
    expect(platformRefusalReason(text)).toBe(reason)
  })

  it.each([
    "Error code: 429 - {'error': {'message': 'Rate limit exceeded'}}", // an upstream's English is left alone
    'rate_limit: HTTP 429: Rate limit exceeded',
    'Connection reset by peer',
    ''
  ])('finds none in %j', text => {
    expect(platformRefusalReason(text)).toBeNull()
  })
})

describe('enterpriseErrorCard', () => {
  it('leaves the card alone outside enterprise mode', () => {
    expect(enterpriseErrorCard(CARD, surface('billing', 'billing'), QUOTA, false)).toBe(CARD)
  })

  it('shows the platform sentence for a blocked prompt, under hermes headline', () => {
    expect(enterpriseErrorCard(CARD, surface('provider', 'content_policy_blocked'), CONTENT_FILTER, true)).toEqual({
      body: '内容涉及敏感信息，已被拦截（content_filter）：Input data may contain inappropriate content.',
      title: CARD.title
    })
  })

  it('titles a quota or authorization refusal without blaming a personal account', () => {
    expect(enterpriseErrorCard(CARD, surface('billing', 'billing'), QUOTA, true)).toEqual({
      body: '你本周期的额度（1 积分）已用完，请联系管理员调整',
      title: '额度已用完'
    })
    expect(
      enterpriseErrorCard(CARD, surface('auth', 'auth', { authKind: 'api_key', provider: 'custom' }), SUSPENDED, true)
    ).toEqual({ body: '你已被企业停用，请联系管理员', title: '企业管理平台拒绝了这次请求' })
    expect(enterpriseErrorCard(CARD, surface('auth', 'auth'), 'Error code: 401', true)).toEqual({
      body: '请联系企业管理员。',
      title: '企业管理平台拒绝了这次请求'
    })
  })

  it('keeps hermes words when the platform said nothing it can show', () => {
    expect(enterpriseErrorCard(CARD, surface('provider', 'server_error'), 'Error code: 502', true)).toBe(CARD)
  })
})

describe('enterpriseRecoveryPlan', () => {
  it('drops "update API key" and "sign in again" in enterprise mode only', () => {
    const plan = errorRecoveryPlan(surface('auth', 'auth', { authKind: 'api_key', provider: 'custom' }))
    expect(plan.updateApiKey).toBe(true)
    expect(enterpriseRecoveryPlan(plan, false)).toBe(plan)
    expect(enterpriseRecoveryPlan(plan, true)).toEqual({ ...plan, signInAgain: false, updateApiKey: false })
  })
})

describe('enterprise mode flag', () => {
  it('follows the entry account and gates the top-up prompt and the platform MCP nudges', () => {
    noteEntryAccount({ display: '100****0002' })
    expect(skipsTopUpPrompt()).toBe(false)
    expect(isPlatformMcpServer('yuanjing')).toBe(false)

    noteEntryAccount({ display: '100****0002', enterprise: { access: 'active' } })
    expect(skipsTopUpPrompt()).toBe(true)
    expect(isPlatformMcpServer('yuanjing')).toBe(true)
    expect(isPlatformMcpServer('uniwork-ent-orders')).toBe(true)
    expect(isPlatformMcpServer('uniwork-ent-uniwork-knowledge')).toBe(true)
    expect(isPlatformMcpServer('linear')).toBe(false)

    noteEntryAccount(null)
    expect(skipsTopUpPrompt()).toBe(false)
  })
})
