import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $enterpriseUsage,
  cycleText,
  type EnterpriseUsage,
  levelText,
  refreshEnterpriseUsage,
  resetEnterpriseUsageForTests,
  usageSummary,
  watchEnterpriseUsage
} from './enterprise-usage-mt'

const working = vi.hoisted(() => ({ ids: null as null | { get: () => string[]; set: (ids: string[]) => void } }))

vi.mock('@/store/session-states', async () => {
  const { atom: makeAtom } = await import('nanostores')
  const store = makeAtom<string[]>([])
  working.ids = store

  return { $workingSessionIds: store }
})

// 平台 39 号第 1.2 节的真实数据
const REAL: EnterpriseUsage = {
  available: true,
  binding: 'enterprise',
  cycleEnd: '',
  cycleStart: '2026-11-03',
  endsAt: '2027-11-03',
  exceeded: false,
  levels: [
    { label: '企业订阅积分', level: 'enterprise', limit: 60000, percent: 31, remaining: 41384, used: 18616 },
    { label: '个人额度', level: 'member', limit: 0, percent: null, remaining: null, used: 17 }
  ],
  unit: '积分'
}

describe('the line under the account name', () => {
  it('shows what is left of the level that runs out first, yellow from 80%, red once a level is used up', () => {
    expect(usageSummary(REAL)).toEqual({ percent: 31, text: '剩余 41,384 积分', tone: 'ok' })

    const tight = { ...REAL, levels: [{ ...REAL.levels![0], percent: 85, remaining: 9000, used: 51000 }, REAL.levels![1]] }

    expect(usageSummary(tight)).toMatchObject({ text: '剩余 9,000 积分', tone: 'warn' })

    const over = { ...REAL, exceeded: true, levels: [{ ...REAL.levels![0], percent: 100, remaining: 0, used: 60000 }] }

    expect(usageSummary(over)).toEqual({ percent: 100, text: '企业订阅积分已用完', tone: 'over' })
  })

  it('says how much was used this cycle when no level has a limit, and stays away without a seat', () => {
    const unlimited = { ...REAL, binding: '', levels: [{ ...REAL.levels![1], used: 1234 }] }

    expect(usageSummary(unlimited)).toEqual({ percent: null, text: '本周期已用 1,234 积分', tone: 'ok' })
    expect(usageSummary({ available: false })).toBeNull() // 没席位、已停用：不显示
    expect(usageSummary({ available: false, error: '额度暂时读不到，稍后再试。' })).toMatchObject({ text: '额度暂不可用' })
    expect(usageSummary(null)).toBeNull()
  })

  it('writes each level and the cycle the way the platform asked', () => {
    expect(levelText(REAL.levels![0])).toBe('18,616 / 60,000')
    expect(levelText(REAL.levels![1])).toBe('已用 17，不限')
    expect(cycleText(REAL)).toBe('本周期自 2026-11-03 起')
    expect(cycleText({ ...REAL, cycleEnd: '2026-12-02' })).toBe('本周期 2026-11-03 至 2026-12-02')
  })
})

describe('refreshing', () => {
  let get: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    resetEnterpriseUsageForTests()
    working.ids?.set([])
    get = vi.fn(async () => REAL)
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { getEnterpriseUsage: get } })
  })

  afterEach(() => {
    resetEnterpriseUsageForTests()
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'hermesDesktop')
  })

  it('reads on start, every minute and after each turn, with one timer however many places watch', async () => {
    const stopA = watchEnterpriseUsage()
    const stopB = watchEnterpriseUsage()
    await vi.waitFor(() => expect($enterpriseUsage.get()).toEqual(REAL))
    expect(get).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(get).toHaveBeenCalledTimes(2)

    working.ids?.set(['s1']) // 一轮对话开始：不取
    await vi.advanceTimersByTimeAsync(0)
    expect(get).toHaveBeenCalledTimes(2)
    working.ids?.set([]) // 这一轮结束：取一次
    await vi.advanceTimersByTimeAsync(0)
    expect(get).toHaveBeenCalledTimes(3)

    stopA()
    stopB()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(get).toHaveBeenCalledTimes(3) // 都不看了就停
  })

  it('keeps the last good reading when a refresh fails, and says so only when there was none', async () => {
    await refreshEnterpriseUsage()
    get.mockRejectedValueOnce(new Error('down'))
    await refreshEnterpriseUsage()
    expect($enterpriseUsage.get()).toEqual(REAL)

    resetEnterpriseUsageForTests()
    get.mockRejectedValueOnce(new Error('down'))
    await refreshEnterpriseUsage()
    expect($enterpriseUsage.get()).toEqual({ available: false, error: '额度暂时读不到，稍后再试。' })
  })

  it('does nothing where the bridge has no quota (personal edition, desktop app)', async () => {
    Reflect.deleteProperty(window, 'hermesDesktop')
    await refreshEnterpriseUsage()
    expect($enterpriseUsage.get()).toBeNull()
  })
})
