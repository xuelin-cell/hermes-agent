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

const READY_TIMEOUT_MS = 8000
// The fresh draft settles a beat after the profile switch and may clear the
// box; a second write covers that without racing a user who is already typing.
const SETTLE_MS = [150, 700]

function setComposerText(text: string): void {
  host.setComposerText(text)
}

/** Fill *text* once the focused chat is a draft in *profile*. */
function prefillWhenReady(profile: string, text: string): void {
  const ready = () => host.state.focusedSessionProfile.get() === profile && !host.state.focusedSessionId.get()

  const fill = () => {
    for (const delay of SETTLE_MS) {
      setTimeout(() => {
        if (ready()) {
          setComposerText(text)
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
  setComposerText(text)
}

/** Back to the general assistant: a new chat in the default profile. */
export function leaveExpert(): void {
  host.newChat('default')
}
