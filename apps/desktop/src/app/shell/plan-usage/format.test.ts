import { expect, it } from 'vitest'

import {
  formatPlanExpiryDate,
  formatTokenQuotaCompact,
  formatTokenQuotaExact,
  formatTokenQuotaPercent,
  formatUsagePercentage,
  formatUsageResetTime
} from './format'

it('按旧版侧栏格式展示截止日期、紧凑额度与两位小数百分比', () => {
  expect(formatPlanExpiryDate('2026-12-17 10:30:00', 'zh')).toBe('2026年12月17日')
  expect(formatPlanExpiryDate('not-a-date', 'zh')).toBeNull()
  expect(formatTokenQuotaCompact(200_000, 'zh')).toBe('20万')
  expect(formatTokenQuotaCompact(7_211, 'zh')).toBe('7211')
  expect(formatTokenQuotaExact(200_000, 'zh')).toBe('200,000')
  expect(formatTokenQuotaPercent(3.613, 'zh')).toBe('3.61')
  expect(formatUsagePercentage(35, 'zh')).toBe('35')
  expect(formatUsagePercentage(3.6, 'zh')).toBe('3.60')
})

it('重置时间按当天、48 小时内和更远分级', () => {
  const now = new Date(2026, 11, 17, 9, 0).getTime()
  expect(formatUsageResetTime(new Date(2026, 11, 17, 15, 30).getTime(), now, 'zh')).toBe('15:30')

  const withinTwoDays = formatUsageResetTime(new Date(2026, 11, 18, 8, 0).getTime(), now, 'zh')
  expect(withinTwoDays).toContain('18')
  expect(withinTwoDays).toContain('08:00')

  expect(formatUsageResetTime(new Date(2026, 11, 25, 8, 0).getTime(), now, 'zh')).toBe('12月25日')
})
