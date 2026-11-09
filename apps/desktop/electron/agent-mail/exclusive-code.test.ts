import { afterEach, expect, it, vi } from 'vitest'

import { fetchWoMailExclusiveCode } from './exclusive-code'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('reads the exclusive code from the Wo Mail response envelope', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({ code: '200', data: { exclusiveCode: '  wo-private-code  ' } })
  )
  vi.stubGlobal('fetch', request)

  await expect(fetchWoMailExclusiveCode('13800138000')).resolves.toBe('wo-private-code')
  expect(request).toHaveBeenCalledOnce()
  expect(request.mock.calls[0]?.[0]).toBe(
    'https://zeus.mail.wo.cn/openapi/mail/exclusive/set?appId=smart-home-service'
  )
})

it('preserves the safe upstream message from an HTTP rejection', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({ message: '号码未开通沃邮箱' }, { status: 403 })
  )

  await expect(fetchWoMailExclusiveCode('13800138000', request)).rejects.toThrow('号码未开通沃邮箱')
})
