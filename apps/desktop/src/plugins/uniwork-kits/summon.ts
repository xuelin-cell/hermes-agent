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
 *
 * The card appears immediately. The backend may still be starting; sending
 * stays closed until this profile is the focused one, or for 30 seconds.
 */

import { type ComposerMiddleware, host } from '@hermes/plugin-sdk'

import { openPooledProfileCount } from '@/store/gateway'
import { $poolLimits } from '@/store/pool-limits'

import { recordSummon } from './api'
import { connectorLoginBlocksSend, dismissConnectorLogin, offerConnectorLogin } from './connector-login'
import { $expertDirectory } from './experts-store'
import { openingPrompt } from './summon-model'
import {
  $expertSummon,
  beginExpertSummon,
  clearExpertSummon,
  expertSummonBlocksSend,
  finishExpertSummon,
  noteExpertSummonFailure
} from './summon-state'
import type { ExpertCard } from './types'

// An expert whose backend is not running yet starts on the first summon, which
// can take a while on a cold machine.
const READY_TIMEOUT_MS = 30_000
// The fresh draft settles a beat after the profile switch and may clear the
// box; a second write covers that. Both only fill an empty box, so a draft the
// user carried over or started typing is never overwritten.
const SETTLE_MS = [150, 700]
let summonTicket = 0

interface QuietChatHost {
  newChat: (profile: string, options?: { quiet?: boolean; onError?: (error: unknown) => void }) => void
  warmProfile?: (profile: string) => void
}

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

/** 把开场白放进新对话的输入框。ifEmpty 时，框里已有字就不覆盖。 */
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

/** 等焦点落到该专家的空草稿后，再写入开场白。 */
function prefillWhenReady(profile: string, text: string): void {
  /** 焦点已经在这个专家的档案上，而且还是没有会话的新草稿。 */
  const ready = () => host.state.focusedSessionProfile.get() === profile && !host.state.focusedSessionId.get()

  /** 按 SETTLE_MS 的几个时间点各写一次开场白（只写进空输入框），盖住草稿刚切换过来时被清空的那一下。 */
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

/** 点专家后立刻显示卡片，并在后台把后端拉起来。 */
export function summonExpert(expert: ExpertCard): void {
  const ticket = ++summonTicket

  const poolFull = openPooledProfileCount() >= $poolLimits.get().maxBackends

  beginExpertSummon(expert.profile, expert.display_name, poolFull)
  // 取数要靠连接器、而通用助手还没连上时，先弹窗问要不要去连接（见 ./connector-login）。
  void offerConnectorLogin(expert)
  void recordSummon(expert.name)
    .then(result => $expertDirectory.set({ ...$expertDirectory.get(), recent: result.recent ?? [] }))
    .catch(() => undefined)

  const quietHost = host as unknown as QuietChatHost

  quietHost.warmProfile?.(expert.profile)
  quietHost.newChat(expert.profile, {
    quiet: true,
    onError: error => {
      if (ticket === summonTicket) {
        noteExpertSummonFailure(error instanceof Error ? error.message : String(error ?? ''))
      }
    }
  })

  const prompt = openingPrompt(expert)

  if (prompt) {
    prefillWhenReady(expert.profile, prompt)
  }

  const stop = host.state.focusedSessionProfile.listen(() => {
    if (ticket !== summonTicket) {
      stop()

      return
    }

    if (host.state.focusedSessionProfile.get() === expert.profile) {
      stop()
      window.clearTimeout(timer)
      finishExpertSummon(expert.profile)
    }
  })

  const timer = window.setTimeout(() => {
    stop()

    if (ticket !== summonTicket) {
      return
    }

    if (host.state.focusedSessionProfile.get() === expert.profile) {
      finishExpertSummon(expert.profile)

      return
    }

    const current = $expertSummon.get()

    if (current?.profile === expert.profile && current.phase === 'preparing') {
      noteExpertSummonFailure(current.poolFull ? 'timed out while waiting for a free slot' : 'timed out')
    }
  }, READY_TIMEOUT_MS)

  if (host.state.focusedSessionProfile.get() === expert.profile) {
    stop()
    window.clearTimeout(timer)
    finishExpertSummon(expert.profile)
  }
}

/** 把一条建议问题放进当前输入框。 */
export function fillPrompt(text: string): void {
  void putPrompt(text, false).catch(() => undefined)
}

/** 回到通用助手：默认 profile 里开一条新对话。 */
export function leaveExpert(): void {
  summonTicket += 1
  clearExpertSummon()
  dismissConnectorLogin()
  host.newChat('default')
}

/** 鼠标停在专家上时先把后端热起来，点下去就不用从零启动。 */
export function warmExpert(profile: string): void {
  ;(host as unknown as QuietChatHost).warmProfile?.(profile)
}

/** 专家还在准备、没有连上，或者连接器提示还没答复时，召唤出来的那条新草稿不能发送，消息留在输入框里。已有的对话不受影响。 */
export const summonSendGuard: ComposerMiddleware = {
  handler: draft => {
    const focused = host.state.focusedSessionId.get()

    return expertSummonBlocksSend(focused) || (!focused && connectorLoginBlocksSend()) ? null : draft
  }
}
