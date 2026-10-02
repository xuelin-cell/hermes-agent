import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import type { CaptchaResult } from '../../../electron/login/contract'

import { useCaptcha } from './use-captcha'

/** 创建可控制响应顺序的请求，模拟迟到的验证码结果。 */
function deferred() {
  let resolve!: (value: CaptchaResult) => void

  const promise = new Promise<CaptchaResult>(done => {
    resolve = done
  })

  return { promise, resolve }
}

it('最新刷新胜出，旧响应不能覆盖，失败可重试', async () => {
  const first = deferred()
  const second = deferred()
  const bridge = { captcha: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) }
  const hook = renderHook(() => useCaptcha(bridge))
  act(() => {
    void hook.result.current.refresh()
  })
  await act(async () => second.resolve({ ok: true, captcha: { captchaId: 'new', imageDataUrl: 'new-image' } }))
  await act(async () => first.resolve({ ok: true, captcha: { captchaId: 'old', imageDataUrl: 'old-image' } }))
  expect(hook.result.current.captcha?.captchaId).toBe('new')
  bridge.captcha.mockResolvedValueOnce({ ok: false })
  await act(async () => {
    await hook.result.current.refresh()
  })
  expect(hook.result.current.failed).toBe(true)
  expect(hook.result.current.captcha).toBeNull()
  bridge.captcha.mockResolvedValueOnce({ ok: true, captcha: { captchaId: 'retry', imageDataUrl: 'retry-image' } })
  await act(async () => {
    await hook.result.current.refresh()
  })
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  expect(hook.result.current.captcha?.captchaId).toBe('retry')
  expect(hook.result.current.failed).toBe(false)
  hook.unmount()
})
