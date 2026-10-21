import type { ContextBreakdown, UsageStats } from '@/types/hermes'

/** 圆环提示保留一位小数，便于比较实际用量与配置上限。 */
export function formatContextTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`
  }

  return String(Math.round(value))
}

/** 列表上限省略无意义的末尾小数，与 UniWork 的紧凑标签一致。 */
export function formatContextSize(value: number): string {
  return formatContextTokens(value).replace(/\.0([KM])$/, '$1')
}

/** 配置决定容量，明细优先决定用量；新对话不继承上一会话的数字。 */
export function composerContextUsage({
  configurationMax,
  fresh,
  breakdown,
  usage
}: {
  configurationMax?: number
  fresh: boolean
  breakdown: ContextBreakdown | null
  usage: UsageStats
}) {
  const max = configurationMax ?? breakdown?.context_max ?? usage.context_max ?? 0

  if (!Number.isFinite(max) || max <= 0) {
    return null
  }

  const used = fresh ? 0 : Math.max(0, breakdown?.context_used ?? usage.context_used ?? 0)
  const percent = Number(((used / max) * 100).toFixed(1))
  const estimated = !fresh && (breakdown?.context_estimated ?? usage.context_estimated ?? false)

  return { max, used, percent, progress: Math.min(100, percent), estimated }
}
