import { expect, it, vi } from 'vitest'

import { CloudDriveClient } from './cloud-drive'

// 验证明确的云盘过期信号只刷新一次，且重复进入不复用已失效令牌。
it('refreshes expired drive credentials and keeps the current login private', async () => {
  const identity = {
    uid: 'a',
    token: 'login-a',
    phone: '13800000000',
    maskedPhone: '138****0000',
    expiresAt: Date.now() + 60_000
  }

  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ meta: { code: '' }, result: { accessToken: 'expired' } }))
    .mockResolvedValueOnce(Response.json({ ok: false, error: { code: 'DRIVE_AUTH_EXPIRED' } }))
    .mockResolvedValueOnce(Response.json({ meta: { code: '' }, result: { accessToken: 'fresh' } }))
    .mockImplementation(async () => Response.json({ ok: true, data: { items: [] } }))

  const client = new CloudDriveClient(() => identity, request)
  expect(await client.execute({ route: '/asset-spaces' })).toEqual({ items: [] })
  expect(await client.execute({ route: '/asset-spaces' })).toEqual({ items: [] })
  expect(request).toHaveBeenCalledTimes(5)
  expect(request.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization')
  expect(request.mock.calls[4][1]?.headers).toHaveProperty('X-Drive-Access-Token', 'fresh')
})

// 验证身份变化后缓存隔离，旧记录无完整手机号时不发送请求。
it('isolates account credentials and rejects legacy identities and invalid routes', async () => {
  let identity = {
    uid: 'a',
    token: 'login-a',
    phone: '13800000000',
    maskedPhone: '138****0000',
    expiresAt: Date.now() + 60_000
  }

  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async url =>
      String(url).endsWith('access-token')
        ? Response.json({ meta: { code: '' }, result: { accessToken: identity.token + '-drive' } })
        : Response.json({ ok: true, data: { items: [] } })
    )

  const client = new CloudDriveClient(() => identity, request)

  for (const token of ['login-a', 'login-b', 'login-a']) {
    identity = { ...identity, token }
    await client.execute({ route: '/asset-spaces' })
  }

  expect(request.mock.calls.filter(([url]) => String(url).endsWith('access-token'))).toHaveLength(3)
  await expect(client.execute({ route: '/assets/../admin', method: 'PATCH' })).rejects.toThrow('不受支持')
  identity = { ...identity, phone: '' }
  await expect(client.execute({ route: '/asset-spaces' })).rejects.toThrow('重新登录一次')
  expect(request).toHaveBeenCalledTimes(6)
})
