import { expect, it } from 'vitest'

import type { ContextBreakdown, UsageStats } from '@/types/hermes'

import { composerContextUsage, formatContextSize, formatContextTokens } from './context-usage'

const usage: UsageStats = {
  calls: 1,
  input: 10,
  output: 5,
  total: 15,
  context_used: 37000,
  context_max: 100000,
  context_estimated: true
}

it('用量保留一位小数单位，列表上限去除多余小数', () => {
  expect([999, 37000, 300000, 1500000].map(formatContextTokens)).toEqual(['999', '37.0K', '300.0K', '1.5M'])
  expect([300000, 1000000, 1500000].map(formatContextSize)).toEqual(['300K', '1M', '1.5M'])
})

it('配置上限优先，百分比保留一位且仅圆环进度封顶', () => {
  expect(composerContextUsage({ configurationMax: 300000, fresh: false, breakdown: null, usage })).toEqual({
    max: 300000,
    used: 37000,
    percent: 12.3,
    progress: 12.3,
    estimated: true
  })
  expect(composerContextUsage({ configurationMax: 10000, fresh: false, breakdown: null, usage })).toMatchObject({
    percent: 370,
    progress: 100
  })
})

it('明细优先于流式用量，估算标记跟随同一来源，新对话强制归零', () => {
  const breakdown = { context_used: 1500, context_max: 200000, context_estimated: false } as ContextBreakdown
  expect(composerContextUsage({ fresh: false, breakdown, usage })).toMatchObject({
    used: 1500,
    estimated: false,
    max: 200000
  })
  expect(composerContextUsage({ fresh: true, breakdown, usage })).toMatchObject({
    used: 0,
    percent: 0,
    estimated: false
  })
  expect(
    composerContextUsage({ fresh: false, breakdown: null, usage: { ...usage, context_max: undefined } })
  ).toBeNull()
})
