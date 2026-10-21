/** 配额展示沿用旧版侧栏规则：窄卡片用紧凑额度，精确值只进提示与无障碍标签。 */
export function formatTokenQuotaCompact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(value)
}

export function formatTokenQuotaExact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0
  }).format(value)
}

/** Token 套餐百分比固定两位小数，避免侧栏宽度随数值跳动。 */
export function formatTokenQuotaPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)
}

/** Coding 周期整数不带小数，非整数保留两位。 */
export function formatUsagePercentage(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2
  }).format(value)
}

/** 网关的 endTime 不带时区时按本地时间解释，非法值返回 null 由界面显示破折号。 */
export function formatPlanExpiryDate(value: unknown, locale: string): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const trimmed = value.trim()
  const localMatch = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed)

  let expiry: Date

  if (localMatch) {
    const year = Number(localMatch[1])
    const monthIndex = Number(localMatch[2]) - 1
    const day = Number(localMatch[3])
    const hour = Number(localMatch[4])
    const minute = Number(localMatch[5])
    const second = Number(localMatch[6] ?? 0)
    expiry = new Date(year, monthIndex, day, hour, minute, second)

    if (
      expiry.getFullYear() !== year ||
      expiry.getMonth() !== monthIndex ||
      expiry.getDate() !== day ||
      expiry.getHours() !== hour ||
      expiry.getMinutes() !== minute ||
      expiry.getSeconds() !== second
    ) {
      return null
    }
  } else {
    expiry = new Date(trimmed)

    if (!Number.isFinite(expiry.getTime())) {
      return null
    }
  }

  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: locale.toLowerCase().startsWith('zh') ? 'long' : 'short',
    day: 'numeric'
  }).format(expiry)
}

/** 重置时间按距离分级：当天只给时间，48 小时内加日期，更远只给日期。 */
export function formatUsageResetTime(deadline: number, now: number, locale: string): string {
  const deadlineDate = new Date(deadline)
  const nowDate = new Date(now)
  const sameLocalDay =
    deadlineDate.getFullYear() === nowDate.getFullYear() &&
    deadlineDate.getMonth() === nowDate.getMonth() &&
    deadlineDate.getDate() === nowDate.getDate()
  const withinTwoDays = deadline > now && deadline - now <= 2 * 24 * 60 * 60 * 1000

  let options: Intl.DateTimeFormatOptions

  if (sameLocalDay) {
    options = {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }
  } else if (withinTwoDays) {
    options = {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }
  } else {
    options = {
      month: 'short',
      day: 'numeric'
    }
  }

  return new Intl.DateTimeFormat(locale, options).format(deadlineDate)
}
