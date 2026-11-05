/**
 * Manual "check for updates" entry points (sidebar account card + Settings).
 *
 * Separate from the passive poller in store/updates: this flow always gives the
 * user a visible answer — either the updates overlay (an update is waiting) or
 * the lightweight "software update" dialog (already current / failed).
 */

import { atom } from 'nanostores'

import { translateNow } from '@/i18n'

import {
  $updateChecking,
  $updateOverlayTarget,
  $updateStatus,
  checkUpdates,
  refreshDesktopVersion,
  setUpdateOverlayOpen
} from './updates'

export type UpdateCheckPhase = 'checking' | 'latest' | 'error'

export interface UpdateCheckDialogState {
  open: boolean
  phase: UpdateCheckPhase
  /** Only set on 'error': the reason shown under the dialog title. */
  message: string | null
}

const CLOSED: UpdateCheckDialogState = { open: false, phase: 'checking', message: null }

export const $updateCheckDialog = atom<UpdateCheckDialogState>(CLOSED)

// Bumped on every open and close: a slow check must not reopen the dialog the
// user already dismissed, nor overwrite a newer request.
let generation = 0

export function closeUpdateCheckDialog(): void {
  generation++
  $updateCheckDialog.set(CLOSED)
}

let inFlight = false

/**
 * A passive check (startup, 24h poll, window focus) can be in flight when the
 * user clicks. checkUpdates() answers from the cache while $updateChecking is
 * true, so a brand-new build would be reported as "already latest". Wait for
 * that check to settle instead of trusting its stale result.
 */
function waitForPassiveCheck(timeoutMs = 20_000): Promise<void> {
  if (!$updateChecking.get()) {
    return Promise.resolve()
  }

  return new Promise<void>(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined

    const finish = (): void => {
      if (settled) {
        return
      }

      settled = true

      if (timer) {
        clearTimeout(timer)
      }

      unsubscribe?.()
      resolve()
    }

    unsubscribe = $updateChecking.subscribe(checking => {
      if (!checking) {
        finish()
      }
    })

    // subscribe() replays the current value synchronously — the check may have
    // finished between the guard above and here.
    if (settled) {
      unsubscribe()
      return
    }

    timer = setTimeout(finish, timeoutMs)
  })
}

function updateWaiting(status = $updateStatus.get()): boolean {
  return Boolean(status?.updateAvailable) || (status?.behind ?? 0) > 0
}

function failureMessage(status = $updateStatus.get()): string {
  if (status?.message) {
    return status.message
  }

  return status?.supported === false
    ? translateNow('updates.unsupportedMessage')
    : translateNow('updates.updateCheckFailed')
}

/**
 * Run one manual client check and render its outcome.
 *
 * Only ever inspects the desktop client, never the connected backend: the
 * affordance says "check for an app update", and remote backends keep their
 * own card/overlay flow.
 */
export async function requestUpdateCheck(): Promise<void> {
  if (inFlight) {
    return
  }

  inFlight = true
  const request = ++generation
  $updateCheckDialog.set({ open: true, phase: 'checking', message: null })

  try {
    await waitForPassiveCheck()

    if (request !== generation) {
      return
    }

    await refreshDesktopVersion()

    const status = await checkUpdates({ force: true })

    // Dismissed (or replaced) while the check was running: drop the result.
    if (request !== generation) {
      return
    }

    if (status && !status.error && status.supported !== false && !status.retirement && updateWaiting(status)) {
      closeUpdateCheckDialog()
      // The status was just force-checked, so drop straight into the overlay
      // instead of openUpdateOverlayFor(), which would force another check.
      $updateOverlayTarget.set('client')
      setUpdateOverlayOpen(true)

      return
    }

    if (!status || status.error || status.supported === false || status.retirement) {
      $updateCheckDialog.set({ open: true, phase: 'error', message: failureMessage(status) })

      return
    }

    $updateCheckDialog.set({ open: true, phase: 'latest', message: null })
  } finally {
    inFlight = false
  }
}
