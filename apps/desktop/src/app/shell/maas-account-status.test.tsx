import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { ContribRender } from '@/contrib/react/boundary'
import { I18nProvider } from '@/i18n/context'
import { notify } from '@/store/notifications'

import { useMaasAccountStatusbarItem } from './maas-account-status'

vi.mock('@/store/notifications', () => ({ notify: vi.fn() }))

const originalBridge = window.hermesDesktop

afterEach(() => {
  window.hermesDesktop = originalBridge
  vi.useRealTimers()
  vi.mocked(notify).mockClear()
})

it('登录页套餐拒绝提示随账号进入桌面，重复聚焦不再次打断，退出入口仍可用', async () => {
  const expiresAt = Date.now() + 60_000
  const logoutMaasAccount = vi.fn(async () => {})
  window.hermesDesktop = {
    getMaasAccount: vi.fn(async () => ({ maskedPhone: '138****0000', expiresAt, planAuthRejected: true })),
    logoutMaasAccount
  } as never
  render(<AccountFixture />)
  await screen.findByRole('button', { name: '退出' })
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: 'maas-plan-rejected' }))
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(notify).toHaveBeenCalledTimes(1)
  expect(logoutMaasAccount).not.toHaveBeenCalled()
})

it('从主进程读取脱敏账号，重新聚焦读取失败后隐藏旧信息', async () => {
  const getMaasAccount = vi.fn().mockResolvedValue({ maskedPhone: '138****0000', expiresAt: Date.now() + 60_000 })
  window.hermesDesktop = { getMaasAccount } as never
  const { result } = renderHook(useMaasAccountStatusbarItem)
  await waitFor(() => expect(result.current?.label).toBe('138****0000'))
  expect(getMaasAccount).toHaveBeenCalledWith()
  expect(result.current?.variant).toBe('text')
  expect(result.current?.menuContent).toBeUndefined()
  expect(result.current?.onSelect).toBeUndefined()
  getMaasAccount.mockRejectedValueOnce(new Error('unavailable'))
  act(() => window.dispatchEvent(new Event('focus')))
  await waitFor(() => expect(result.current).toBeNull())
})

it('未登录不显示账号，主进程保留到期账号时展示与退出入口仍保留', async () => {
  vi.useFakeTimers()
  const getMaasAccount = vi.fn().mockResolvedValue(null)
  window.hermesDesktop = { getMaasAccount } as never
  const { result } = renderHook(useMaasAccountStatusbarItem)
  await act(async () => {})
  expect(result.current).toBeNull()
  getMaasAccount.mockResolvedValue({ maskedPhone: '139****0000', expiresAt: Date.now() + 1000 })
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(result.current?.label).toBe('139****0000')
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(result.current?.label).toBe('139****0000')
  expect(getMaasAccount).toHaveBeenCalledTimes(2)
})

/** 真实渲染状态栏贡献与统一确认弹窗，不用替身模拟退出按钮。 */
function AccountFixture() {
  const item = useMaasAccountStatusbarItem()

  return (
    <I18nProvider configClient={null} initialLocale="zh">
      {item?.render ? <ContribRender render={item.render} /> : null}
    </I18nProvider>
  )
}

it('只有账号和退出入口，取消不注销，确认合并重复点击并显示主进程错误', async () => {
  let fail!: (error: Error) => void

  const logoutMaasAccount = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        fail = reject
      })
  )

  window.hermesDesktop = {
    getMaasAccount: vi.fn().mockResolvedValue({ maskedPhone: '138****0000', expiresAt: Date.now() + 60_000 }),
    logoutMaasAccount
  } as never
  render(<AccountFixture />)
  fireEvent.click(await screen.findByRole('button', { name: '退出' }))
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(logoutMaasAccount).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '退出' }))
  const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: '退出' })
  fireEvent.click(confirm)
  fireEvent.click(confirm)
  expect(logoutMaasAccount).toHaveBeenCalledTimes(1)
  await act(async () => fail(new Error('无法开始安全退出，请重试。')))
  expect(await screen.findByText('无法开始安全退出，请重试。')).toBeTruthy()
  expect(screen.getByText('138****0000')).toBeTruthy()
})

it('重新聚焦获得同一展示身份时，退出确认不被组件重挂打断', async () => {
  const expiresAt = Date.now() + 60_000
  const getMaasAccount = vi.fn(async () => ({ maskedPhone: '138****0000', expiresAt }))
  window.hermesDesktop = { getMaasAccount, logoutMaasAccount: vi.fn() } as never
  render(<AccountFixture />)
  fireEvent.click(await screen.findByRole('button', { name: '退出' }))
  const dialog = screen.getByRole('dialog')
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(getMaasAccount).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('dialog')).toBe(dialog)
  fireEvent.click(within(dialog).getByRole('button', { name: '退出' }))
  expect(window.hermesDesktop.logoutMaasAccount).toHaveBeenCalledTimes(1)
})

it.each(['timer', 'wake'])('到期 %s 只提示一次，保留已打开确认和手动退出，不自动注销', async mode => {
  vi.useFakeTimers()
  const expiresAt = Date.now() + 1000
  const logoutMaasAccount = vi.fn(async () => {})
  window.hermesDesktop = {
    getMaasAccount: vi.fn(async () => ({ maskedPhone: '138****0000', expiresAt })),
    logoutMaasAccount
  } as never
  render(<AccountFixture />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: '退出' }))
  const dialog = screen.getByRole('dialog')

  if (mode === 'timer') {
    await act(async () => vi.advanceTimersByTimeAsync(1000))
  } else {
    vi.setSystemTime(expiresAt + 1000)
    await act(async () => window.dispatchEvent(new Event('focus')))
  }

  expect(screen.getByText('登录已到期')).toBeTruthy()
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(notify).toHaveBeenCalledTimes(1)
  expect(logoutMaasAccount).not.toHaveBeenCalled()
  await act(async () => window.dispatchEvent(new Event('focus')))
  await act(async () => vi.advanceTimersByTimeAsync(120_000))
  expect(notify).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('dialog')).toBe(dialog)
  fireEvent.click(within(dialog).getByRole('button', { name: '退出' }))
  expect(logoutMaasAccount).toHaveBeenCalledTimes(1)
})
