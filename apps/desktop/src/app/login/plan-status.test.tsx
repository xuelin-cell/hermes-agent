import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'

import type { PlanResult } from '../../../electron/login/contract'

import { PlanStatus } from './plan-status'

/** 挂载真实套餐展示组件，只替换受限 IPC 返回值。 */
function fixture(plan: () => Promise<PlanResult>) {
  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <PlanStatus bridge={{ plan }} />
    </I18nProvider>
  )
}

it('独立展示套餐名称与默认模型，失败可重试，空套餐仍说明自定义模型可用', async () => {
  const plan = vi
    .fn()
    .mockResolvedValueOnce({ status: 'failed' })
    .mockResolvedValueOnce({
      status: 'available',
      models: [
        { name: 'fixture-model-a', isDefault: false },
        { name: 'fixture-model-b', isDefault: true }
      ]
    })
    .mockResolvedValueOnce({ status: 'empty' })

  const view = fixture(plan)
  await screen.findByText('套餐查询失败，请重试。')
  expect(screen.getByText('仍可使用自定义模型。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText('fixture-model-a')
  expect(screen.getByText(/fixture-model-b.*默认/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  view.unmount()
  fixture(plan)
  await screen.findByText('当前没有 MaaS 套餐。')
  expect(screen.getByText('仍可使用自定义模型。')).toBeTruthy()
  expect(plan).toHaveBeenCalledTimes(3)
})

it('异常不泄露内部错误；组件卸载后，旧响应不会污染下一次展示', async () => {
  let resolve!: (result: PlanResult) => void

  const plan = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<PlanResult>(done => {
          resolve = done
        })
    )
    .mockRejectedValueOnce(new Error('private-error-detail'))

  const first = fixture(plan)
  first.unmount()
  fixture(plan)
  await screen.findByText('套餐查询失败，请重试。')
  await act(async () => resolve({ status: 'available', models: [{ name: 'old-account-model', isDefault: true }] }))
  expect(screen.queryByText('old-account-model')).toBeNull()
  expect(screen.queryByText('private-error-detail')).toBeNull()
})
