import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

import { LoginSession } from '../login/session'

import { prepareLocalAccount, prepareLocalModelConfig } from './prepare-account'

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

it('真实账号文件只消费最新成功套餐；查询失败、空套餐和无身份均不能覆盖已有配置', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-prepare-model-'))
  const roots = { data: path.join(root, 'data'), userData: path.join(root, 'desktop') }
  const request = vi.fn<typeof fetch>()

  const session = new LoginSession(request, {
    save: vi.fn(),
    load: vi.fn().mockReturnValue({
      uid: 'account-A',
      token: 'login-token',
      maskedPhone: '138****0000',
      expiresAt: Date.now() + 60_000
    })
  })

  try {
    expect(session.currentPlan()).toEqual({ status: 'failed' })
    session.restore()
    const account = prepareLocalModelConfig(session, roots)
    const file = path.join(account.home, 'config.yaml')
    expect(fs.existsSync(file)).toBe(false)
    request.mockResolvedValueOnce(
      Response.json({
        apiKey: 'private-model-key',
        models: { models: [{ id: 'a', model: 'model-a', base_url: 'https://models.invalid/a/v1' }] }
      })
    )
    await session.queryPlan()
    const handed = session.currentPlan()
    expect(handed.status).toBe('available')

    if (handed.status === 'available') {
      handed.plan.models[0].name = 'forged-model'
      handed.plan.apiKey = 'forged-key'
    }

    expect(prepareLocalModelConfig(session, roots)).toEqual(account)
    const saved = fs.readFileSync(file, 'utf8')
    expect(saved).toContain('model-a')
    expect(saved).not.toContain('private-model-key')
    expect(saved).not.toContain('forged')
    request.mockRejectedValueOnce(new Error('private-network-error'))
    await session.queryPlan()
    expect(session.currentPlan()).toEqual({ status: 'failed' })
    fs.writeFileSync(file, `${saved}# 失败时不重写\n`)
    const before = fs.readFileSync(file, 'utf8')
    prepareLocalModelConfig(session, roots)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    request.mockResolvedValueOnce(Response.json({ apiKey: null, models: null }))
    await session.queryPlan()
    expect(session.currentPlan()).toEqual({ status: 'empty' })
    prepareLocalModelConfig(session, roots)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    session.dispose()
    expect(session.currentPlan()).toEqual({ status: 'failed' })
    expect(() => prepareLocalModelConfig(session, roots)).toThrow('请先登录')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  } finally {
    session.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
