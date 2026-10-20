import { afterEach, describe, expect, it } from 'vitest'

import {
  beginExpertSummon,
  clearExpertSummon,
  expertSummonBlocksSend,
  finishExpertSummon,
  noteExpertSummonFailure
} from './summon-state'

describe('sending while an expert is being summoned', () => {
  afterEach(() => clearExpertSummon())

  it('holds the summoned draft until the expert is ready, and lets it go once it is', () => {
    beginExpertSummon('fund-diagnostician', '基金诊断专家')
    expect(expertSummonBlocksSend(null)).toBe(true)

    finishExpertSummon('fund-diagnostician')
    expect(expertSummonBlocksSend(null)).toBe(false)
  })

  it('keeps holding the draft after a failed summon, until the user leaves or tries again', () => {
    beginExpertSummon('fund-diagnostician', '基金诊断专家')
    noteExpertSummonFailure('Backend for "fund-diagnostician" was retired; open it explicitly to reconnect.')
    expect(expertSummonBlocksSend('')).toBe(true)

    clearExpertSummon()
    expect(expertSummonBlocksSend('')).toBe(false)
  })

  it('never holds a conversation that already exists', () => {
    beginExpertSummon('fund-diagnostician', '基金诊断专家')
    expect(expertSummonBlocksSend('20261019_101500_abcdef')).toBe(false)
  })
})
