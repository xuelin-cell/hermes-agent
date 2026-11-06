import { readBrowserAuth, requestEntryMaas } from '../../../shared/src/browser-maas-auth.js'
import type { LoginAccount } from '../../electron/login/contract'
import type { PlanSubscriptionResult, PlanUsageResult } from '../../electron/uniwork-usage/contract'

/**
 * Same bridge contract as desktop; browser credentials only travel to fixed Entry business routes.
 *
 * `sessionAccount` answers under the unified login only. There the entry reads usage for the gateway's session, the
 * very one the account item shows, but the two name and date it from different sources (the gateway's display
 * name and a session it renews vs. the entry's masked phone and session end): the panel's same-account check would
 * never match and always read "signed out". A switch of account reloads the page (lib/sso-mt.ts).
 */
export function browserPlan(base: string, sessionAccount: () => Promise<LoginAccount | null> = async () => null) {
  let subscribing = false

  const failed = () => readBrowserAuth(base) ? { status: 'failed' as const } : { status: 'failed' as const, reason: 'auth' as const }

  async function usage(force: boolean): Promise<PlanUsageResult> {
    try {
      const result = await requestEntryMaas<PlanUsageResult>(base, force ? 'plan/refresh' : 'plan/usage')

      if (result.status !== 'available') {
        return result
      }

      const account = await sessionAccount()

      return account ? { ...result, account: { maskedPhone: account.maskedPhone, expiresAt: account.expiresAt } } : result
    } catch {
      return failed()
    }
  }

  async function subscribe(): Promise<PlanSubscriptionResult> {
    if (!readBrowserAuth(base)) {
      return { status: 'failed', reason: 'auth' }
    }

    if (subscribing) {
      return { status: 'failed', reason: 'upstream' }
    }

    // Open within the click gesture, before the ticket request; asynchronous window.open is blocked by browsers.
    const popup = window.open('about:blank', '_blank')

    if (!popup) {
      return { status: 'failed', reason: 'popup-blocked' }
    }

    popup.opener = null
    subscribing = true

    try {
      const result = await requestEntryMaas<{ status: 'ready'; url: string } | PlanSubscriptionResult>(base, 'plan/subscribe')

      if (result.status !== 'ready') {
        popup.close()

        return result
      }

      const url = new URL(result.url)

      if (popup.closed || url.origin !== 'https://market.ai-yuanjing.com' || url.pathname !== '/' || url.search || !url.hash.startsWith('#/active?')) {
        throw new Error('Invalid subscription handoff')
      }

      popup.location.replace(url.href)

      return { status: 'opened' }
    } catch {
      popup.close()

      return readBrowserAuth(base) ? { status: 'failed', reason: 'upstream' } : { status: 'failed', reason: 'auth' }
    } finally {
      subscribing = false
    }
  }

  return {
    getPlanUsage: () => usage(false),
    refreshPlanUsage: () => usage(true),
    subscribeMaasPlan: subscribe
  }
}
