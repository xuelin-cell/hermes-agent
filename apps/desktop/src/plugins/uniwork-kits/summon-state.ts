import { atom } from 'nanostores'

import { $poolLimits } from '@/store/pool-limits'

/** 对话框里正在召唤的专家。准备好或离开后清空。 */
export interface ExpertSummon {
  profile: string
  displayName: string
  phase: 'preparing' | 'failed'
  error?: string
}

export const $expertSummon = atom<ExpertSummon | null>(null)

const FAILED = '这位专家的后端没有连上，请再点一次。'

/** 池子名额用尽时的原文（主进程 pool-spawn-coordinator）。 */
const SLOT_WAIT = 'waiting for a free slot'

function slotFullMessage(): string {
  return `同时进行的专家已到上限（${$poolLimits.get().maxBackends} 个）。等一位专家结束，再点一次。`
}

/** 开始一次召唤。同一时间只保留最后一次。 */
export function beginExpertSummon(profile: string, displayName: string): void {
  $expertSummon.set({ profile, displayName, phase: 'preparing' })
}

/** 后端已经切到这位专家，准备状态结束。 */
export function finishExpertSummon(profile: string): void {
  const current = $expertSummon.get()

  if (current?.profile === profile) {
    $expertSummon.set(null)
  }
}

/** 放弃当前召唤，例如回到通用助手。 */
export function clearExpertSummon(): void {
  $expertSummon.set(null)
}

/** 安静切换失败时，把原因留在专家卡片上。 */
export function noteExpertSummonFailure(message: string): void {
  const current = $expertSummon.get()

  if (!current || current.phase !== 'preparing') {
    return
  }

  const readable = message.includes(SLOT_WAIT)
    ? slotFullMessage()
    : /timed out|retired|failed to open/i.test(message)
      ? FAILED
      : message.trim() || FAILED

  $expertSummon.set({ ...current, phase: 'failed', error: readable })
}

/** 召唤出来的新草稿（还没有会话 id）在专家准备中或失败时不能发送；已有的对话不受影响。 */
export function expertSummonBlocksSend(focusedSessionId: null | string | undefined): boolean {
  const phase = $expertSummon.get()?.phase

  return !focusedSessionId && (phase === 'preparing' || phase === 'failed')
}

export const EXPERT_SUMMON_FAILED = FAILED
