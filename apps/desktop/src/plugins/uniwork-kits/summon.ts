/**
 * Summoning an expert — 数字员工's 「召唤专家」 on Hermes terms.
 *
 * An expert is its own profile, so a summon is a new chat in that profile (the
 * same door as the sidebar's per-profile "+" and Bots' "new chat with this
 * bot"), with the expert's opening prompt left in the input box to edit and
 * send. It never sends anything itself. "Leaving" an expert opens a new chat
 * with the general assistant: a conversation keeps the profile and system
 * prompt it started with, so switching inside one would break prompt caching
 * and profile isolation.
 */

import { host } from '@hermes/plugin-sdk'

import { recordSummon } from './api'
import { $expertDirectory } from './experts-store'
import { openingPrompt } from './summon-model'
import type { ExpertCard } from './types'

// An expert whose backend is not running yet starts on the first summon, which
// can take a while on a cold machine.
const READY_TIMEOUT_MS = 30_000
// The fresh draft settles a beat after the profile switch and may clear the
// box; a second write covers that. Both only fill an empty box, so a draft the
// user carried over or started typing is never overwritten.
const SETTLE_MS = [150, 700]

/** The two composer doors desktops have shipped: newer ones expose
 *  `host.composer` (draft read/write by session address, `'new'` = the draft
 *  with no session yet); older ones only `host.setComposerText`. */
interface ComposerDoor {
  getDraft: (sessionId: null | string) => Promise<null | string>
  setDraft: (sessionId: null | string, text: string) => Promise<boolean>
}

interface HostComposerDoors {
  composer?: ComposerDoor
  setComposerText?: (text: string, options?: { ifEmpty?: boolean }) => void
}

/** Put *text* in the new chat's input box; with *ifEmpty*, only when the box is empty. */
async function putPrompt(text: string, ifEmpty: boolean): Promise<void> {
  const doors = host as unknown as HostComposerDoors

  if (doors.composer) {
    if (ifEmpty && (await doors.composer.getDraft('new'))?.trim()) {
      return
    }

    await doors.composer.setDraft('new', text)

    return
  }

  doors.setComposerText?.(text, { ifEmpty })
}

/** Fill *text* once the focused chat is a draft in *profile*. */
function prefillWhenReady(profile: string, text: string): void {
  const ready = () => host.state.focusedSessionProfile.get() === profile && !host.state.focusedSessionId.get()

  const fill = () => {
    for (const delay of SETTLE_MS) {
      setTimeout(() => {
        if (ready()) {
          void putPrompt(text, true).catch(() => undefined)
        }
      }, delay)
    }
  }

  if (ready()) {
    fill()

    return
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  const stop = host.state.focusedSessionProfile.listen(() => {
    if (ready()) {
      stop()
      clearTimeout(timer)
      fill()
    }
  })

  timer = setTimeout(stop, READY_TIMEOUT_MS)
}

export function summonExpert(expert: ExpertCard): void {
  void recordSummon(expert.name)
    .then(result => $expertDirectory.set({ ...$expertDirectory.get(), recent: result.recent ?? [] }))
    .catch(() => undefined)
  host.newChat(expert.profile)

  const prompt = openingPrompt(expert)

  if (prompt) {
    prefillWhenReady(expert.profile, prompt)
  }
}

/** Put a quick prompt in the chat on screen. */
export function fillPrompt(text: string): void {
  void putPrompt(text, false).catch(() => undefined)
}

/** Back to the general assistant: a new chat in the default profile. */
export function leaveExpert(): void {
  host.newChat('default')
}
