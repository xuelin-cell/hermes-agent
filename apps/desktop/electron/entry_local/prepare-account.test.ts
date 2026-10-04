import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

import { LoginSession } from '../login/session'

import { prepareLocalAccount, prepareLocalEnvironment } from './prepare-account'
import { LocalStartupError } from './startup-failure'

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
    expect(() => prepareLocalAccount(next, roots)).toThrow(LocalStartupError)
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

it('真实账号准备只消费最新成功套餐；失败保留 Key，空套餐撤销 Key，写入失败不能完成准备', async () => {
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
    const account = prepareLocalEnvironment(session, roots)
    const file = path.join(account.home, 'config.yaml')
    const envFile = path.join(account.home, '.env')
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(envFile)).toBe(false)
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

    expect(prepareLocalEnvironment(session, roots)).toEqual(account)
    const saved = fs.readFileSync(file, 'utf8')
    expect(saved).toContain('model-a')
    expect(saved).not.toContain('private-model-key')
    expect(saved).not.toContain('forged')
    const envSaved = fs.readFileSync(envFile, 'utf8')
    expect(envSaved).toContain('private-model-key')
    expect(envSaved).not.toContain('login-token')
    expect(envSaved).not.toContain('forged')
    request.mockRejectedValueOnce(new Error('private-network-error'))
    await session.queryPlan()
    expect(session.currentPlan()).toEqual({ status: 'failed' })
    fs.writeFileSync(file, `${saved}# 失败时不重写\n`)
    const before = fs.readFileSync(file, 'utf8')
    prepareLocalEnvironment(session, roots)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.readFileSync(envFile, 'utf8')).toBe(envSaved)
    request.mockResolvedValueOnce(Response.json({ apiKey: null, models: null }))
    await session.queryPlan()
    expect(session.currentPlan()).toEqual({ status: 'empty' })
    prepareLocalEnvironment(session, roots)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.readFileSync(envFile, 'utf8')).not.toContain('private-model-key')
    request.mockResolvedValueOnce(
      Response.json({
        apiKey: 'refreshed-model-key',
        models: { models: [{ id: 'a', model: 'model-a', base_url: 'https://models.invalid/a/v1' }] }
      })
    )
    await session.queryPlan()
    const cleared = fs.readFileSync(envFile, 'utf8')
    fs.mkdirSync(`${envFile}.tmp`)
    expect(() => prepareLocalEnvironment(session, roots)).toThrow(LocalStartupError)
    expect(fs.readFileSync(envFile, 'utf8')).toBe(cleared)
    fs.rmdirSync(`${envFile}.tmp`)
    prepareLocalEnvironment(session, roots)
    expect(fs.readFileSync(envFile, 'utf8')).toContain('refreshed-model-key')
    const prepared = fs.readFileSync(file, 'utf8')
    session.dispose()
    expect(session.currentPlan()).toEqual({ status: 'failed' })
    expect(() => prepareLocalEnvironment(session, roots)).toThrow('请先登录')
    expect(fs.readFileSync(file, 'utf8')).toBe(prepared)
  } finally {
    session.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
