import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type EnterpriseUsage, resetEnterpriseUsageForTests } from '@/lib/enterprise-usage-mt'

import { EnterpriseUsageDetails, EnterpriseUsageSummary } from './enterprise-usage-mt'

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

function serve(usage: EnterpriseUsage | null) {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: usage ? { getEnterpriseUsage: vi.fn(async () => usage) } : {}
  })
}

beforeEach(() => resetEnterpriseUsageForTests())

afterEach(() => {
  cleanup()
  resetEnterpriseUsageForTests()
  Reflect.deleteProperty(window, 'hermesDesktop')
})

describe('enterprise quota (desktop-mt)', () => {
  it('puts what is left under the account name and every level in the account card', async () => {
    serve(REAL)

    const { container } = render(
      <>
        <EnterpriseUsageSummary />
        <EnterpriseUsageDetails />
      </>
    )

    expect(await screen.findByText('剩余 41,384 积分')).toBeTruthy()
    expect(container.querySelector('.enterprise-usage-summary')?.getAttribute('data-tone')).toBe('ok')
    // 企业订阅积分 = 企业用量，个人额度 = 个人用量
    expect(screen.getByText('企业订阅积分')).toBeTruthy()
    expect(screen.getByText('18,616 / 60,000')).toBeTruthy()
    expect(screen.getByText('个人额度')).toBeTruthy()
    expect(screen.getByText('已用 17，不限')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '企业订阅积分' }).getAttribute('aria-valuenow')).toBe('31')
    expect(screen.getByText('本周期自 2026-11-03 起 · 订阅到期 2027-11-03')).toBeTruthy()
    expect(screen.queryByText(/联系企业管理员/)).toBeNull()
  })

  it('turns red and tells the member to ask the administrator once a level is used up', async () => {
    serve({ ...REAL, exceeded: true, levels: [{ ...REAL.levels![0], percent: 100, remaining: 0, used: 60000 }] })

    const { container } = render(
      <>
        <EnterpriseUsageSummary />
        <EnterpriseUsageDetails />
      </>
    )

    expect(await screen.findByText('企业订阅积分已用完')).toBeTruthy()
    expect(container.querySelector('.enterprise-usage-summary')?.getAttribute('data-tone')).toBe('over')
    expect(screen.getByText(/请联系企业管理员调整额度/)).toBeTruthy()
  })

  it('shows nothing without a seat, nor where the bridge has no quota', async () => {
    serve({ available: false })

    const first = render(
      <>
        <EnterpriseUsageSummary />
        <EnterpriseUsageDetails />
      </>
    )

    await vi.waitFor(() => expect(window.hermesDesktop.getEnterpriseUsage).toHaveBeenCalled())
    expect(first.container.textContent).toBe('')
    first.unmount()

    serve(null) // 个人版、桌面版

    const second = render(
      <>
        <EnterpriseUsageSummary />
        <EnterpriseUsageDetails />
      </>
    )

    expect(second.container.textContent).toBe('')
  })
})
