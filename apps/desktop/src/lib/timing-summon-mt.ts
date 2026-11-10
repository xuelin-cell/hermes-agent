/**
 * desktop-mt: 召唤专家的耗时（见 timing-mt.ts）：点召唤 → 专家准备好、可以发送（prepare）。
 *
 * 跟着专家卡片的状态走（plugins/uniwork-kits/summon-state.ts）：准备中 → 清空，并且聚焦的会话已经切到这位专家，
 * 算准备好（和 summon.ts 判断准备好是同一个条件）；准备中 → 失败，记失败；用户中途离开的不记。之后第一句的
 * 耗时记在 chat.first_turn 里。main.tsx 引入一次；桌面版没有 reportTiming，什么都不做。
 */
import { host } from '@hermes/plugin-sdk'

import { $expertSummon } from '@/plugins/uniwork-kits/summon-state'

import { reportTiming, timingEnabled } from './timing-mt'

let preparing: null | { poolFull: boolean; profile: string; startedAt: number } = null

const seconds = (ms: number) => Math.round(Math.max(0, ms) / 10) / 100

function focusedProfile(): string | undefined {
  try {
    return host.state.focusedSessionProfile.get() ?? undefined
  } catch {
    return undefined
  }
}

$expertSummon.listen(summon => {
  if (summon?.phase === 'preparing') {
    if (preparing?.profile !== summon.profile) {
      preparing = { poolFull: Boolean(summon.poolFull), profile: summon.profile, startedAt: performance.now() }
    }

    return
  }

  const started = preparing
  preparing = null

  if (!started || !timingEnabled()) {
    return
  }

  const ready = summon === null && focusedProfile() === started.profile

  if (summon === null && !ready) {
    return // 准备好之前就离开了
  }

  const spent = seconds(performance.now() - started.startedAt)

  reportTiming({
    kind: 'expert.summon',
    labels: { ok: ready, pool_full: started.poolFull },
    seconds: spent,
    steps: { prepare: spent }
  })
})
