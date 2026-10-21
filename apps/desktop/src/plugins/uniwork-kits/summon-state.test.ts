import { afterEach, describe, expect, it } from 'vitest'

import {
  beginExpertSummon,
  clearExpertSummon,
  expertSummonBlocksSend,
  finishExpertSummon,
  noteExpertSummonFailure
} from './summon-state'

describe('召唤专家期间发送消息', () => {
  afterEach(() => clearExpertSummon())

  it('专家准备好之前拦住召唤出的草稿，准备好后放行', () => {
    beginExpertSummon('fund-diagnostician', '基金诊断专家')
    expect(expertSummonBlocksSend(null)).toBe(true)

    finishExpertSummon('fund-diagnostician')
    expect(expertSummonBlocksSend(null)).toBe(false)
  })

  it('召唤失败后继续拦住，直到用户离开专家或重新召唤', () => {
    beginExpertSummon('fund-diagnostician', '基金诊断专家')
    noteExpertSummonFailure('Backend for "fund-diagnostician" was retired; open it explicitly to reconnect.')
    expect(expertSummonBlocksSend('')).toBe(true)

    clearExpertSummon()
    expect(expertSummonBlocksSend('')).toBe(false)
  })

  it('已经存在的会话从不拦', () => {
    beginExpertSummon('fund-diagnostician', '基金诊断专家')
    expect(expertSummonBlocksSend('20261019_101500_abcdef')).toBe(false)
  })
})
