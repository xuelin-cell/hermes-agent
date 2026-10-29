import { atom } from 'nanostores'

import { getRuntimeI18nLocale } from '@/i18n/runtime'

import type { ErrorRecoveryPlan, ErrorSurface } from './error-surface'
import type { ErrorCardText } from './error-surface-copy'

/**
 * desktop-mt: the cloud entry (deploy/hermes-mt) in enterprise mode. Models, connectors and quota then
 * belong to the enterprise management platform, which refuses a call with its own Chinese sentence
 * (quota used up, member suspended, content blocked: docs/企业版对接/27, the reply to 26 §1). The error
 * card shows that sentence instead of hermes's provider-account wording, and leaves out the fixes that
 * belong to a personal provider account (replace the API key, sign in again, add credits): an employee
 * has none of those, the platform's administrator does. Upstream files reach this through
 * `lib/browser-shell.ts`.
 */

/** True once the entry's `/__entry/me` reported an enterprise binding (the browser bridge sets it). */
export const $enterpriseShell = atom(false)

/** Called by the browser bridge with the entry's `/__entry/me` body. */
export function noteEntryAccount(me: unknown): void {
  $enterpriseShell.set(Boolean(me && typeof me === 'object' && (me as { enterprise?: unknown }).enterprise))
}

const COPY = {
  en: {
    contactAdmin: 'Ask your enterprise administrator.',
    quotaTitle: 'Your quota is used up',
    refusedTitle: 'The enterprise platform refused this request'
  },
  zh: {
    contactAdmin: '请联系企业管理员。',
    quotaTitle: '额度已用完',
    refusedTitle: '企业管理平台拒绝了这次请求'
  }
}

const copy = (locale: string) => (locale.startsWith('zh') ? COPY.zh : COPY.en)

// hermes words a failed call as `[<code>: ]HTTP <status>: <the body's message>`
// (`content_policy_blocked: HTTP 400: 内容涉及敏感信息…`, `HTTP 402: 你本周期的额度…`); a raw body may also
// carry `'message': '…'` (Python repr) or `"message": "…"` (JSON).
const MESSAGE_FIELD = /["']message["']\s*:\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/
const HTTP_STATUS = /HTTP \d{3}:\s*([\s\S]+)$/
const CJK = /[㐀-鿿]/

function unescapeQuoted(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, escaped: string) => {
    if (escaped.length === 5) {
      return String.fromCharCode(parseInt(escaped.slice(1), 16))
    }

    return escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped
  })
}

/** The platform's own sentence in a failed turn's error text (the `message` of its error body), or null
 *  when there is none: the platform always answers in Chinese, an upstream's English text is left alone. */
export function platformRefusalReason(errorText: string): null | string {
  const field = MESSAGE_FIELD.exec(errorText || '')
  const status = field ? null : HTTP_STATUS.exec(errorText || '')
  const reason = field ? unescapeQuoted(field[2]).trim() : (status?.[1].trim() ?? '')

  return reason && CJK.test(reason) ? reason : null
}

/** The error card's words in enterprise mode: the platform's sentence as the body; a quota or authorization
 *  refusal also gets a title that does not blame a personal provider account. `locale` is the component's
 *  (`useI18n().locale`): the runtime locale is only synced after the first render. */
export function enterpriseErrorCard(
  card: ErrorCardText,
  surface: ErrorSurface | null | undefined,
  errorText: string,
  enterprise: boolean,
  locale: string = getRuntimeI18nLocale()
): ErrorCardText {
  if (!enterprise || !surface) {
    return card
  }

  const reason = platformRefusalReason(errorText)
  const words = copy(locale)

  if (surface.layer === 'billing') {
    return { body: reason ?? words.contactAdmin, title: words.quotaTitle }
  }

  if (surface.layer === 'auth') {
    return { body: reason ?? words.contactAdmin, title: words.refusedTitle }
  }

  return reason ? { ...card, body: reason } : card
}

/** The card's buttons in enterprise mode: no "update API key" or "sign in again" (the platform's device
 *  token is the credential, renewed by signing in to the cloud). */
export function enterpriseRecoveryPlan(plan: ErrorRecoveryPlan, enterprise: boolean): ErrorRecoveryPlan {
  return enterprise ? { ...plan, signInAgain: false, updateApiKey: false } : plan
}

/** Whether a quota refusal skips hermes's top-up banner and toast ("add credits"): the card says it. */
export function skipsTopUpPrompt(): boolean {
  return $enterpriseShell.get()
}

/** The MCP servers that reach the platform with the device token: the built-in 元景 tools and the
 *  enterprise's connectors, knowledge and experts (deploy/hermes-mt/seed/mtent.py names them). */
export function isPlatformMcpServer(name: string): boolean {
  return $enterpriseShell.get() && (name === 'yuanjing' || name.startsWith('uniwork-'))
}
