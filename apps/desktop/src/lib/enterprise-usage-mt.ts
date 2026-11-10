/**
 * desktop-mt: 企业版的额度（平台 39 号第 1 节），入口替浏览器去平台取（deploy/hermes-mt/entry/entry/usage_routes.py）。
 *
 * 和企业桌面端一样：每轮对话结束后刷新一次，另外每分钟一次、窗口回到前台一次。界面在 app/shell/enterprise-usage-mt.tsx：
 * 常驻在账号名下面的那一行，和点开账号卡片后顶部的各级明细。没有 getEnterpriseUsage（个人版、桌面版）就什么都不做。
 */
import { atom } from 'nanostores'

import { $workingSessionIds } from '@/store/session-states'

export interface EnterpriseUsageLevel {
  label: string
  /** enterprise / department / member，依次是企业、部门、个人 */
  level: string
  /** 上限；0 = 不设上限，这时 remaining、percent 都是 null */
  limit: number
  percent: null | number
  remaining: null | number
  used: number
}

export interface EnterpriseUsage {
  available: boolean
  /** 最先会用完的那一级；空 = 每一级都没设上限 */
  binding?: string
  cycleEnd?: string
  cycleStart?: string
  endsAt?: string
  error?: string
  /** 有一级用完了：模型调用会被平台拒绝（402） */
  exceeded?: boolean
  levels?: EnterpriseUsageLevel[]
  unit?: string
}

export type UsageTone = 'ok' | 'over' | 'warn'

export interface UsageSummary {
  percent: null | number
  text: string
  tone: UsageTone
}

const POLL_MS = 60_000
const UNREACHABLE = '额度暂时读不到，稍后再试。'

export const $enterpriseUsage = atom<EnterpriseUsage | null>(null)

let inflight: null | Promise<void> = null
let watchers = 0
let stopWatch: (() => void) | null = null

export function enterpriseUsageSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.hermesDesktop?.getEnterpriseUsage === 'function'
}

export function refreshEnterpriseUsage(): Promise<void> {
  const get = typeof window !== 'undefined' ? window.hermesDesktop?.getEnterpriseUsage : undefined

  if (!get) {
    return Promise.resolve()
  }

  inflight ??= get()
    .then(
      usage => $enterpriseUsage.set(usage),
      () => {
        // 取不到就留着上一份能用的；从来没取到过才说一句
        if (!$enterpriseUsage.get()?.available) {
          $enterpriseUsage.set({ available: false, error: UNREACHABLE })
        }
      }
    )
    .finally(() => {
      inflight = null
    })

  return inflight
}

/** 账号名下面那一行挂着时开始刷新；几处同时挂也只有一份定时器。返回取消函数。 */
export function watchEnterpriseUsage(): () => void {
  watchers += 1

  if (watchers === 1) {
    void refreshEnterpriseUsage()
    const timer = setInterval(() => void refreshEnterpriseUsage(), POLL_MS)
    let working = $workingSessionIds.get().length

    // 进行中的会话少了一个 = 有一轮对话结束了
    const offTurns = $workingSessionIds.listen(ids => {
      if (ids.length < working) {
        void refreshEnterpriseUsage()
      }

      working = ids.length
    })

    const onFocus = () => void refreshEnterpriseUsage()
    window.addEventListener('focus', onFocus)

    stopWatch = () => {
      clearInterval(timer)
      offTurns()
      window.removeEventListener('focus', onFocus)
    }
  }

  return () => {
    watchers -= 1

    if (watchers === 0) {
      stopWatch?.()
      stopWatch = null
    }
  }
}

export function formatCredits(value: number): string {
  return value.toLocaleString('zh-CN')
}

function percentOf(level: EnterpriseUsageLevel): number {
  return level.percent ?? (level.limit > 0 ? Math.round((level.used / level.limit) * 1000) / 10 : 0)
}

export function levelTone(level: EnterpriseUsageLevel): UsageTone {
  if (level.limit <= 0) {
    return 'ok'
  }

  if (level.used >= level.limit) {
    return 'over'
  }

  return percentOf(level) >= 80 ? 'warn' : 'ok'
}

export function levelPercent(level: EnterpriseUsageLevel): number {
  return Math.min(100, Math.max(0, percentOf(level)))
}

/** 常驻那一行，按优先级取第一条：有一级用完了 › 最先用完那一级还剩多少 › 本周期已用（都没设上限时）。 */
export function usageSummary(usage: EnterpriseUsage | null): null | UsageSummary {
  if (!usage) {
    return null
  }

  if (!usage.available) {
    // 没席位、已停用（入口不带 error）就不显示；平台连不上才说一句
    return usage.error ? { percent: null, text: '额度暂不可用', tone: 'ok' } : null
  }

  const levels = usage.levels ?? []
  const unit = usage.unit || '积分'
  const binding = levels.find(level => level.level === usage.binding && level.limit > 0)
  const exhausted = levels.find(level => level.limit > 0 && level.used >= level.limit)

  if (exhausted || usage.exceeded) {
    return { percent: 100, text: `${(exhausted ?? binding)?.label ?? '额度'}已用完`, tone: 'over' }
  }

  if (binding) {
    const remaining = binding.remaining ?? Math.max(0, binding.limit - binding.used)

    return { percent: levelPercent(binding), text: `剩余 ${formatCredits(remaining)} ${unit}`, tone: levelTone(binding) }
  }

  const member = levels.find(level => level.level === 'member')

  return member ? { percent: null, text: `本周期已用 ${formatCredits(member.used)} ${unit}`, tone: 'ok' } : null
}

/** 明细里每一级的「已用 / 上限」，没上限时写「已用 N，不限」。 */
export function levelText(level: EnterpriseUsageLevel): string {
  return level.limit > 0
    ? `${formatCredits(level.used)} / ${formatCredits(level.limit)}`
    : `已用 ${formatCredits(level.used)}，不限`
}

/** 明细底部的周期：cycleEnd 为空表示按订阅周期计，写「本周期自 X 起」。 */
export function cycleText(usage: EnterpriseUsage): string {
  const start = usage.cycleStart?.slice(0, 10)

  if (!start) {
    return ''
  }

  return usage.cycleEnd ? `本周期 ${start} 至 ${usage.cycleEnd.slice(0, 10)}` : `本周期自 ${start} 起`
}

/** 测试用。 */
export function resetEnterpriseUsageForTests(): void {
  stopWatch?.()
  stopWatch = null
  watchers = 0
  inflight = null
  $enterpriseUsage.set(null)
}
