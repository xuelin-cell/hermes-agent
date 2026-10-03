import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { SmsResult } from '../../../electron/login/contract'

import { useSms } from './use-sms'

afterEach(() => vi.useRealTimers())

it('发送失败可重试，同帧重复动作被拦截，成功后按期限倒计时且不自动重发', async () => {
  vi.useFakeTimers()
  const input = { phone: '13800000000', captchaCode: 'abcd', captchaId: 'id' }
  let resolve!: (result: SmsResult) => void

  const sendSms = vi.fn().mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )

  const hook = renderHook(() => useSms({ captcha: vi.fn(), sendSms }))
  act(() => {
    void hook.result.current.send(input)
    void hook.result.current.send(input)
  })
  expect(sendSms).toHaveBeenCalledTimes(1)
  expect(hook.result.current.pending).toBe(true)
  await act(async () => resolve({ ok: false, error: 'failed' }))
  expect(hook.result.current.seconds).toBe(0)
  expect(hook.result.current.pending).toBe(false)
  sendSms.mockResolvedValueOnce({ ok: true, retryAt: Date.now() + 60_000 })
  await act(async () => {
    await hook.result.current.send(input)
  })
  expect(hook.result.current.seconds).toBe(60)
  await act(async () => {
    await hook.result.current.send(input)
  })
  expect(sendSms).toHaveBeenCalledTimes(2)
  act(() => {
    vi.setSystemTime(Date.now() + 65_000)
    vi.advanceTimersByTime(1000)
  })
  expect(hook.result.current.seconds).toBe(0)
  expect(sendSms).toHaveBeenCalledTimes(2)
  hook.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
