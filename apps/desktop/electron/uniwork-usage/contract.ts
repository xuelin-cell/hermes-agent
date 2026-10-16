export const PLAN_USAGE_CHANNEL = 'hermes:maas-account:usage'

export interface UsageWindow {
  name: 'five-hour' | 'week' | 'month'
  usedPercent: number
  resetAt: number | null
  notStarted: boolean
}

export interface PlanUsage {
  productName: string
  endTime: string | null
  expired: boolean
  fetchedAt: number
  kind: 'coding_plan' | 'token_plan' | 'unknown'
  windows: UsageWindow[]
  quota: {
    total: number
    used: number
    remaining: number
    usedPercent: number
    unit: 'tokens' | 'credits' | null
  } | null
  concurrency: { current: number | null; limit: number } | null
}

export type PlanUsageResult =
  | { status: 'available'; data: PlanUsage; account: { maskedPhone: string; expiresAt: number } }
  | { status: 'failed'; reason?: 'auth' }

/** 仅接受字段对象，拒绝数组和空值。 */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** 只采纳非负有限用量，不把缺失值补成零。 */
function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** 按权威套餐类型选择用量，仅输出展示白名单，丢弃凭据和模型配置。 */
export function normalizePlanUsage(body: unknown, fetchedAt: number): PlanUsage {
  const envelope = record(body)
  if (!Object.keys(envelope).length || (envelope.code !== undefined && envelope.code !== 0 && envelope.code !== '0'))
    throw new Error('Invalid plan response')
  const data = record(envelope.data === undefined ? body : envelope.data)
  if (!Object.keys(data).length) throw new Error('Missing plan response')
  const kind = data.planType === 'coding_plan' || data.planType === 'token_plan' ? data.planType : 'unknown'
  const coding = record(data.codingPlanUsage),
    token = record(data.tokenPlanUsage)
  const windows: UsageWindow[] = []
  const names = [
    ['five-hour', 'second', 'secondTtl'],
    ['week', 'week', 'weekTtl'],
    ['month', 'month', 'monthTtl']
  ] as const
  if (kind === 'coding_plan')
    for (const [name, key, ttlKey] of names) {
      const used = amount(coding[key]),
        ttl =
          typeof coding[ttlKey] === 'number' && Number.isFinite(coding[ttlKey])
            ? Math.max(0, coding[ttlKey] as number)
            : null
      if (used !== null)
        windows.push({
          name,
          usedPercent: Math.min(100, used),
          resetAt: ttl !== null && ttl > 0 ? Math.min(8_640_000_000_000_000, fetchedAt + ttl * 1000) : null,
          notStarted: ttl === 0
        })
    }
  const total = amount(token.totalQuota),
    used = amount(token.usedQuota),
    limit = amount(token.concurrencyLimit)
  return {
    kind,
    productName: typeof data.productName === 'string' ? data.productName.slice(0, 120) : '',
    endTime: typeof data.endTime === 'string' ? data.endTime.slice(0, 64) : null,
    expired: data.status === 'invalid',
    fetchedAt,
    windows,
    quota:
      kind === 'token_plan' && total !== null && total > 0 && used !== null
        ? {
            total,
            used,
            remaining: Math.max(0, total - used),
            usedPercent: Math.min(100, (used / total) * 100),
            unit: token.quotaUnit === 'tokens' || token.quotaUnit === 'credits' ? token.quotaUnit : null
          }
        : null,
    concurrency:
      kind === 'token_plan' && limit !== null && limit > 0 ? { current: amount(token.currentConcurrency), limit } : null
  }
}
