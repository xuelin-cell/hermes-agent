import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { useMaasAccountStatusbarItem } from './maas-account-status'

const originalBridge = window.hermesDesktop

afterEach(() => {
  window.hermesDesktop = originalBridge
  vi.useRealTimers()
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

it('未登录不显示账号，登录期限结束后重新读取且不执行注销', async () => {
  vi.useFakeTimers()
  const getMaasAccount = vi.fn().mockResolvedValue(null)
  window.hermesDesktop = { getMaasAccount } as never
  const { result } = renderHook(useMaasAccountStatusbarItem)
  await act(async () => {})
  expect(result.current).toBeNull()
  getMaasAccount.mockResolvedValueOnce({ maskedPhone: '139****0000', expiresAt: Date.now() + 1000 })
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(result.current?.label).toBe('139****0000')
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(result.current).toBeNull()
  expect(getMaasAccount).toHaveBeenCalledTimes(3)
})
