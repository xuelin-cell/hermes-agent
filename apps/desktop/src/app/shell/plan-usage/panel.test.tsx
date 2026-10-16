import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { normalizePlanUsage } from '../../../../electron/uniwork-usage/contract'
import { PlanUsagePanel } from './panel'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('从展开到重试使用真实归一化数据，失败保留旧值而账号不匹配时清除', async () => {
  const account = { maskedPhone: '138****0001', expiresAt: Date.now() + 60_000 }
  const data = normalizePlanUsage(
    {
      planType: 'token_plan',
      productName: '专业套餐',
      tokenPlanUsage: { totalQuota: 1000, usedQuota: 250, quotaUnit: 'tokens' }
    },
    Date.now()
  )
  const query = vi.fn().mockResolvedValue({ status: 'available', data, account })
  vi.stubGlobal('hermesDesktop', { getPlanUsage: query })
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <PlanUsagePanel account={account} />
    </I18nProvider>
  )
  expect(query).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '套餐用量' }))
  expect(await screen.findByText('专业套餐')).toBeTruthy()
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
  expect(screen.getByText('剩余：750 tokens')).toBeTruthy()
  query.mockRejectedValueOnce(new Error('network'))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '刷新用量' }))
  })
  expect(await screen.findByText('刷新失败，当前显示上次查询结果。')).toBeTruthy()
  expect(screen.getByText('专业套餐')).toBeTruthy()
  query.mockResolvedValue({ status: 'available', data, account: { ...account, maskedPhone: 'other' } })
  fireEvent.click(screen.getByRole('button', { name: '刷新用量' }))
  await waitFor(() => expect(screen.queryByText('专业套餐')).toBeNull())
  expect(screen.getByText('登录状态已失效，请重新登录后查询。')).toBeTruthy()
})
