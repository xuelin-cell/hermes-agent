import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { notify } from '@/store/notifications'
import { requestUpdateCheck } from '@/store/update-check'
import { normalizePlanUsage } from '../../../../electron/uniwork-usage/contract'
import { PlanUsagePanel } from './panel'

vi.mock('@/store/notifications', () => ({ notify: vi.fn() }))
vi.mock('@/store/update-check', () => ({ requestUpdateCheck: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.mocked(notify).mockClear()
  vi.mocked(requestUpdateCheck).mockClear()
})

it('从展开到重试使用真实归一化数据，失败保留旧值而账号不匹配时清除', async () => {
  const account = { maskedPhone: '138****0001', expiresAt: Date.now() + 60_000 }
  const quotaUnit = '元景积分'
  const data = normalizePlanUsage(
    {
      planType: 'token_plan',
      productName: '专业套餐',
      tokenPlanUsage: { totalQuota: 1000, usedQuota: 250, quotaUnit, concurrencyLimit: 3 }
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
  const usedAmount = screen.getByText('250')
  const remainingAmount = screen.getByText('750')
  expect(usedAmount.className).toContain('plan-usage-quota-number')
  expect(remainingAmount.className).toBe(usedAmount.className)
  expect(remainingAmount.parentElement?.className).toBe('plan-usage-quota-remaining')
  expect(remainingAmount.parentElement?.textContent?.replace(/\s+/g, '')).toBe(`剩余：750${quotaUnit}`)
  expect(usedAmount.closest('[title]')?.querySelector('.plan-usage-quota-total')?.textContent).toContain(quotaUnit)
  expect(usedAmount.closest('[title]')?.getAttribute('title')).toContain(quotaUnit)
  expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toContain(quotaUnit)
  expect(usedAmount.closest('[title]')?.contains(remainingAmount)).toBe(true)
  expect(screen.getByText('25.00%').previousElementSibling?.textContent).toBe('已使用')
  expect(screen.queryByText(/当前并发/)).toBeNull()
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

it('头像卡片展示真实套餐，详情按需展开，设置沿用现有路由', async () => {
  const account = { maskedPhone: '138****0001', expiresAt: Date.now() + 60_000 }
  const data = normalizePlanUsage(
    {
      planType: 'token_plan',
      productName: '真实套餐',
      endTime: '2026-12-12',
      tokenPlanUsage: { totalQuota: 1000, usedQuota: 250, quotaUnit: 'tokens' }
    },
    Date.now()
  )
  const query = vi.fn().mockResolvedValue({ status: 'available', data, account })
  const subscribe = vi.fn().mockResolvedValue({ status: 'opened' })
  vi.stubGlobal('hermesDesktop', { getPlanUsage: query, subscribeMaasPlan: subscribe })
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter>
        <Routes>
          <Route
            path="/"
            element={<PlanUsagePanel account={account} trigger={<button>头像</button>} onLogout={vi.fn()} />}
          />
          <Route path="/settings" element={<h1>设置页面</h1>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>
  )
  expect(query).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '头像' }))
  expect(await screen.findByText('真实套餐')).toBeTruthy()
  expect(document.querySelectorAll('.account-card-icon > svg')).toHaveLength(6)
  expect(document.querySelector('.account-card-icon')?.getAttribute('style')).toBeNull()
  expect(screen.getByText('2026年12月12日 到期')).toBeTruthy()
  expect(screen.getByText('已使用 25.00%')).toBeTruthy()
  expect(screen.queryByRole('progressbar')).toBeNull()
  const usageRow = screen.getByRole('button', { name: /套餐实际用量/ })
  expect(usageRow.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('button', { name: '查看详情' })).toBeNull()
  expect(usageRow.querySelector('.codicon-chevron-right')).toBeTruthy()
  fireEvent.click(usageRow)
  expect(usageRow.getAttribute('aria-expanded')).toBe('true')
  expect(screen.queryByText('已使用 25.00%')).toBeNull()
  expect(usageRow.querySelector('.codicon-chevron-down')).toBeTruthy()
  const meter = screen.getByRole('progressbar')
  expect(usageRow.nextElementSibling?.contains(meter)).toBe(true)
  expect(meter.getAttribute('aria-valuenow')).toBe('25')
  expect(subscribe).not.toHaveBeenCalled()
  const viewDetails = screen.getByRole('button', { name: '查看详情' })
  expect(usageRow.nextElementSibling?.contains(viewDetails)).toBe(true)
  expect(viewDetails.closest('.plan-usage-summary')?.contains(screen.getByText('25.00%'))).toBe(true)
  expect(viewDetails.closest('[title]')).toBeNull()
  fireEvent.click(viewDetails)
  await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))
  expect(usageRow.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(usageRow)
  expect(usageRow.getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByText('已使用 25.00%')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '查看详情' })).toBeNull()
  fireEvent.click(screen.getByRole('link', { name: '设置' }))
  expect(await screen.findByRole('heading', { name: '设置页面' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull()
})

it('账号卡片提供检查更新入口，点击后收起卡片并触发检查', async () => {
  const account = { maskedPhone: '138****0001', expiresAt: Date.now() + 60_000 }
  const query = vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'restart' })
  vi.stubGlobal('hermesDesktop', { getPlanUsage: query })
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter>
        <PlanUsagePanel account={account} trigger={<button>头像</button>} onLogout={vi.fn()} />
      </MemoryRouter>
    </I18nProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: '头像' }))
  const checkRow = await screen.findByRole('button', { name: '检查更新' })
  fireEvent.click(checkRow)
  expect(requestUpdateCheck).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(screen.queryByRole('button', { name: '检查更新' })).toBeNull())
})

it('旧主进程给出重启提示，接口可用后展示 Coding 周期摘要而非空余额', async () => {
  const account = { maskedPhone: '138****0001', expiresAt: Date.now() + 60_000 }
  vi.stubGlobal('hermesDesktop', {})
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter>
        <PlanUsagePanel account={account} trigger={<button>头像</button>} onLogout={vi.fn()} />
      </MemoryRouter>
    </I18nProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: '头像' }))
  expect(await screen.findByText('用量查询组件尚未更新，请完全退出并重新启动桌面应用。')).toBeTruthy()
  const data = normalizePlanUsage(
    { planType: 'coding_plan', productName: 'Coding 套餐', codingPlanUsage: { second: 35, secondTtl: 7200 } },
    Date.now()
  )
  const query = vi.fn().mockResolvedValue({ status: 'available', data, account })
  vi.stubGlobal('hermesDesktop', { getPlanUsage: query })
  fireEvent.click(screen.getByRole('button', { name: '刷新套餐信息' }))
  expect(await screen.findByText('已用 35% · 5 小时额度')).toBeTruthy()
  expect(screen.queryByText('用量查询组件尚未更新，请完全退出并重新启动桌面应用。')).toBeNull()
  expect(screen.queryByText('剩余0')).toBeNull()
})

it('账号卡片只保留顶部刷新入口，展开收起不搬动套餐状态提示', async () => {
  const account = { maskedPhone: '138****0001', expiresAt: Date.now() + 60_000 }
  const data = normalizePlanUsage(
    { planType: 'token_plan', productName: '真实套餐', tokenPlanUsage: { totalQuota: 1000, usedQuota: 250 } },
    Date.now()
  )
  const query = vi.fn().mockResolvedValue({ status: 'available', account, data })
  const refresh = vi.fn().mockResolvedValue({ status: 'failed' })
  vi.stubGlobal('hermesDesktop', { getPlanUsage: query, refreshPlanUsage: refresh })
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter>
        <PlanUsagePanel account={account} onLogout={vi.fn()} trigger={<button>头像</button>} />
      </MemoryRouter>
    </I18nProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: '头像' }))
  await screen.findByText('真实套餐')
  fireEvent.click(screen.getByRole('button', { name: '刷新套餐信息' }))
  const message = '刷新失败，当前显示上次查询结果。'
  const status = await screen.findByText(message)
  const settings = screen.getByRole('link', { name: '设置' })
  const usageRow = screen.getByRole('button', { name: /套餐实际用量/ })
  expect(usageRow.querySelector('.account-card-summary')?.textContent).toBe('已使用 25.00%')
  expect(usageRow.hasAttribute('disabled')).toBe(false)
  expect(status.nextElementSibling).toBe(settings)
  expect(screen.queryByRole('button', { name: '刷新用量' })).toBeNull()
  for (const expanded of [true, false]) {
    fireEvent.click(usageRow)
    expect(usageRow.getAttribute('aria-expanded')).toBe(String(expanded))
    expect(screen.getByText(message)).toBe(status)
    expect(status.nextElementSibling).toBe(settings)
    expect(screen.queryByRole('button', { name: '刷新用量' })).toBeNull()
    expect(screen.queryByRole('progressbar') !== null).toBe(expanded)
  }
  fireEvent.click(usageRow)
  refresh.mockResolvedValue({ status: 'failed', reason: 'auth' })
  fireEvent.click(screen.getByRole('button', { name: '刷新套餐信息' }))
  await screen.findByText('登录状态已失效，请重新登录后查询。')
  expect(usageRow.querySelector('.account-card-summary')?.textContent).toBe('—')
  expect(usageRow.hasAttribute('disabled')).toBe(true)
  expect(usageRow.getAttribute('aria-expanded')).toBe('false')
  expect(usageRow.querySelector('.account-card-chevron')).toBeNull()
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.queryByRole('button', { name: '查看详情' })).toBeNull()
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(query).toHaveBeenCalledTimes(1)
})

it('无用量时摘要显示破折号，失败原因仅由固定提示说明，正常空数据保持原样', async () => {
  const account = { maskedPhone: '138****0001', expiresAt: Date.now() + 60_000 }
  let finish!: (value: unknown) => void
  const query = vi.fn(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const refresh = vi.fn().mockResolvedValue({ status: 'failed', reason: 'auth' })
  vi.stubGlobal('hermesDesktop', { getPlanUsage: query, refreshPlanUsage: refresh })
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter>
        <PlanUsagePanel account={account} onLogout={vi.fn()} trigger={<button>头像</button>} />
      </MemoryRouter>
    </I18nProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: '头像' }))
  const usageRow = screen.getByRole('button', { name: /套餐实际用量/ })
  const refreshButton = screen.getByRole('button', { name: '刷新套餐信息' })
  expect(usageRow.textContent).toContain('—')
  expect(usageRow.hasAttribute('disabled')).toBe(false)
  expect(screen.getAllByText('正在查询套餐用量…')).toHaveLength(1)
  expect(screen.queryByRole('status')).toBeNull()
  expect(refreshButton.querySelector('.animate-spin')).toBeTruthy()
  expect(screen.queryByText('暂无可展示的用量数据')).toBeNull()
  await act(async () => finish({ status: 'failed' }))
  expect(screen.getByRole('status').textContent).toBe('刷新失败，请重试。')
  expect(usageRow.querySelector('.account-card-summary')?.textContent).toBe('—')
  expect(usageRow.hasAttribute('disabled')).toBe(true)
  expect(usageRow.querySelector('.account-card-chevron')).toBeNull()
  fireEvent.click(usageRow)
  expect(usageRow.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('button', { name: '查看详情' })).toBeNull()
  expect(screen.queryByText('暂无可展示的用量数据')).toBeNull()
  fireEvent.click(refreshButton)
  await screen.findByText('登录状态已失效，请重新登录后查询。')
  expect(usageRow.querySelector('.account-card-summary')?.textContent).toBe('—')
  expect(usageRow.hasAttribute('disabled')).toBe(true)
  expect(usageRow.querySelector('.account-card-chevron')).toBeNull()
  expect(screen.queryByText('暂无可展示的用量数据')).toBeNull()
  vi.stubGlobal('hermesDesktop', {})
  fireEvent.click(refreshButton)
  await screen.findByText('用量查询组件尚未更新，请完全退出并重新启动桌面应用。')
  expect(usageRow.querySelector('.account-card-summary')?.textContent).toBe('—')
  expect(usageRow.hasAttribute('disabled')).toBe(false)
  expect(usageRow.querySelector('.account-card-chevron')).toBeTruthy()
  expect(screen.queryByText('暂无可展示的用量数据')).toBeNull()
  const data = normalizePlanUsage({ planType: 'token_plan', productName: '真实套餐' }, Date.now())
  refresh.mockResolvedValue({ status: 'available', account, data })
  vi.stubGlobal('hermesDesktop', { getPlanUsage: query, refreshPlanUsage: refresh })
  fireEvent.click(refreshButton)
  await waitFor(() => expect(usageRow.textContent).toContain('暂无可展示的用量数据'))
  expect(usageRow.hasAttribute('disabled')).toBe(false)
  expect(usageRow.querySelector('.account-card-chevron')).toBeTruthy()
  expect(screen.queryByText('刷新失败，请重试。')).toBeNull()
  expect(screen.queryByText('登录状态已失效，请重新登录后查询。')).toBeNull()
  fireEvent.click(usageRow)
  expect(screen.getByText('暂无可展示的用量数据')).toBeTruthy()
})

it('网站入口各自展示忙碌状态，防重复并提示失败原因，手动刷新绕过常规查询', async () => {
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
  const refresh = vi.fn().mockResolvedValue({ status: 'available', data, account })
  let finish!: (value: unknown) => void
  const subscribe = vi.fn(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  vi.stubGlobal('hermesDesktop', { getPlanUsage: query, refreshPlanUsage: refresh, subscribeMaasPlan: subscribe })
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter>
        <PlanUsagePanel account={account} trigger={<button>头像</button>} onLogout={vi.fn()} />
      </MemoryRouter>
    </I18nProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: '头像' }))
  expect(await screen.findByText('专业套餐')).toBeTruthy()

  const subscribeButton = screen.getByRole('button', { name: '订阅' })
  fireEvent.click(subscribeButton)
  fireEvent.click(subscribeButton)
  expect(subscribe).toHaveBeenCalledTimes(1)
  const usageRow = screen.getByRole('button', { name: /套餐实际用量/ })
  fireEvent.click(usageRow)
  const viewDetails = screen.getByRole('button', { name: '查看详情' })
  expect(subscribeButton.textContent).toBe('正在打开…')
  expect(viewDetails.hasAttribute('disabled')).toBe(false)
  expect(viewDetails.getAttribute('aria-busy')).toBe('false')
  fireEvent.click(viewDetails)
  expect(subscribe).toHaveBeenCalledTimes(1)
  await act(async () => finish({ status: 'failed', reason: 'missing-phone' }))
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: '请重新登录后再订阅。' }))
  expect(viewDetails.hasAttribute('disabled')).toBe(false)
  fireEvent.click(viewDetails)
  expect(viewDetails.hasAttribute('disabled')).toBe(true)
  expect(viewDetails.getAttribute('aria-busy')).toBe('true')
  expect(subscribeButton.textContent).toBe('订阅')
  expect(subscribeButton.hasAttribute('disabled')).toBe(false)
  expect(subscribeButton.getAttribute('aria-busy')).toBe('false')
  fireEvent.click(viewDetails)
  fireEvent.click(subscribeButton)
  expect(subscribe).toHaveBeenCalledTimes(2)
  await act(async () => finish({ status: 'opened' }))
  expect(viewDetails.hasAttribute('disabled')).toBe(false)
  expect(viewDetails.getAttribute('aria-busy')).toBe('false')
  expect(usageRow.getAttribute('aria-expanded')).toBe('true')

  fireEvent.click(screen.getByRole('button', { name: '刷新套餐信息' }))
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  expect(query).toHaveBeenCalledTimes(1)
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: '套餐信息已刷新' }))
})
