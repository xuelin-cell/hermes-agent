import { expect, it, vi } from 'vitest'

import { CloudDriveClient } from './cloud-drive'
import { LoginSession } from './session'
import { MAAS_IDENTITY_NAMESPACE } from './credential-store'

// 恢复已保存登录后直接认证云盘，重复进入仍复用云盘令牌；页面只获得脱敏账号。
it('uses the saved phone for cloud drive after restoring login', async () => {
  const saved = {
    namespace: MAAS_IDENTITY_NAMESPACE,
    uid: 'saved-user', token: 'saved-token', phone: '13800000000',
    maskedPhone: '138****0000', expiresAt: Date.now() + 60_000
  }
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ meta: { code: '' }, result: { accessToken: 'drive-token' } }))
    .mockImplementation(async () => Response.json({ ok: true, data: { items: [] } }))
  const session = new LoginSession(request, { save: vi.fn(), load: vi.fn().mockReturnValue(saved) })
  expect(session.restore()).toEqual({
    ok: true, account: { maskedPhone: saved.maskedPhone, expiresAt: saved.expiresAt }
  })
  const drive = new CloudDriveClient(() => session.currentIdentity(), request)
  expect(await drive.execute({ route: '/asset-spaces' })).toEqual({ items: [] })
  expect(await drive.execute({ route: '/asset-spaces' })).toEqual({ items: [] })
  expect(JSON.parse(String(request.mock.calls[0][1]?.body)).phone).toBe(saved.phone)
  expect(request).toHaveBeenCalledTimes(3)
})

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
