import { atom } from 'nanostores'

import { $poolLimits } from '@/store/pool-limits'

/** 对话框里正在召唤的专家。准备好或离开后清空。 */
export interface ExpertSummon {
  profile: string
  displayName: string
  phase: 'preparing' | 'failed'
  error?: string
  /** 点下去时专家名额已满。准备过程中就说明在等空位，失败时用上限文案，而不是「正在准备」或「后端没连上」。 */
  poolFull?: boolean
}

export const $expertSummon = atom<ExpertSummon | null>(null)

const FAILED = '这位专家的后端没有连上，请再点一次。'

/** 池子名额用尽时的原文（主进程 pool-spawn-coordinator）。 */
const SLOT_WAIT = 'waiting for a free slot'

function slotFullMessage(): string {
  return `同时进行的专家已到上限（${$poolLimits.get().maxBackends} 个）。等一位专家结束，再点一次。`
}

/** 名额已满、召唤还在等空位时，卡片上替换「正在准备」。 */
export function slotWaitingMessage(): string {
  return `同时进行的专家已到上限（${$poolLimits.get().maxBackends} 个），正在等空位。`
}

/** 开始一次召唤。同一时间只保留最后一次。`poolFull` 为真时准备阶段就提示名额。 */
export function beginExpertSummon(profile: string, displayName: string, poolFull = false): void {
  $expertSummon.set({ profile, displayName, phase: 'preparing', poolFull })
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

  // 渲染器等连接的超时原文是 “Timed out connecting”，不含 “waiting for a free slot”。
  // 点下去时名额已满的，这次超时就是名额，不是后端没起来。
  const readable =
    message.includes(SLOT_WAIT) || (current.poolFull && /timed out/i.test(message))
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
