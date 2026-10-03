import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

import { LoginSession } from '../login/session'

import { prepareLocalAccount } from './prepare-account'

it('目录只取 LoginSession 的有效身份，凭据变更仍复用目录，未登录、到期或关闭不能准备', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-prepare-account-'))
  const roots = { data: path.join(root, 'data'), userData: path.join(root, 'desktop') }
  const expiresAt = Date.now() + 60_000
  const request = vi.fn<typeof fetch>()
  const credentials = { save: vi.fn(), load: vi.fn() }
  const session = new LoginSession(request, credentials)

  try {
    expect(() => prepareLocalAccount(session, roots)).toThrow('请先登录')
    expect(fs.existsSync(roots.data)).toBe(false)
    request.mockResolvedValueOnce(Response.json({ uid: 'fixture-A', token: 'fixture-token-A', expiresAt }))
    await session.login({ phone: '13800000000', smsCode: '123456', uid: 'forged-B', home: 'forged-path' })
    const a = prepareLocalAccount(session, roots)
    expect(prepareLocalAccount(session, roots)).toEqual(a)
    session.dispose()
    expect(() => prepareLocalAccount(session, roots)).toThrow('请先登录')
    request.mockResolvedValueOnce(Response.json({ uid: 'fixture-A', token: 'updated-fixture-token', expiresAt }))
    const next = new LoginSession(request, credentials)
    await next.login({ phone: '13900000000', smsCode: '123456' })
    expect(prepareLocalAccount(next, roots)).toEqual(a)
    fs.writeFileSync(path.join(a.workspace, 'marker'), 'keep-file')
    fs.renameSync(a.desktopState, `${a.desktopState}-kept`)
    fs.writeFileSync(a.desktopState, 'blocked-directory')
    expect(() => prepareLocalAccount(next, roots)).toThrow('账号目录准备失败，请检查本地目录后重试。')
    expect(fs.readFileSync(path.join(a.workspace, 'marker'), 'utf8')).toBe('keep-file')
    fs.unlinkSync(a.desktopState)
    fs.renameSync(`${a.desktopState}-kept`, a.desktopState)
    expect(prepareLocalAccount(next, roots)).toEqual(a)
    vi.spyOn(Date, 'now').mockReturnValue(expiresAt)
    expect(() => prepareLocalAccount(next, roots)).toThrow('请先登录')
    expect(fs.readFileSync(path.join(a.workspace, 'marker'), 'utf8')).toBe('keep-file')
    next.dispose()
  } finally {
    vi.restoreAllMocks()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
