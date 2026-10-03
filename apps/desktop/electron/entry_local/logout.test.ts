import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: {} }))

import { createAccountLogout, logoutIntentPath } from './logout'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** 创建仅属于测试的密文占位和可观察停止阶段，不触碰任何真实账号。 */
function fixture() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-logout-'))
  roots.push(userData)
  const credential = path.join(userData, 'maas-login.enc')
  fs.writeFileSync(credential, 'cipher-sentinel')
  const processes = [{ pid: 123, parent: 1, started: '100' }]

  const deps = {
    userData,
    account: 'account-fixture',
    seal: vi.fn(() => {
      expect(fs.existsSync(logoutIntentPath(userData))).toBe(true)
    }),
    snapshot: vi.fn<() => typeof processes | Promise<typeof processes>>(() => processes),
    stop: vi.fn(async () => {}),
    release: vi.fn(),
    relaunch: vi.fn(async () => {})
  }

  return { userData, credential, deps, processes, logout: createAccountLogout(deps) }
}

it('先持久化失效意图，合并重复退出，验证停止后才清除凭据并重启', async () => {
  const { logout, deps, credential, userData } = fixture()
  let finish!: () => void
  deps.stop.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  const first = logout.run()
  expect(logout.run()).toBe(first)
  expect(logout.started()).toBe(true)
  expect(fs.readFileSync(credential, 'utf8')).toBe('cipher-sentinel')
  expect(deps.release).not.toHaveBeenCalled()
  await Promise.resolve()
  finish()
  await first
  expect(deps.seal).toHaveBeenCalledTimes(1)
  expect(deps.release).toHaveBeenCalledTimes(1)
  expect(deps.relaunch).toHaveBeenCalledTimes(1)
  expect(fs.existsSync(credential)).toBe(false)
  expect(fs.existsSync(logoutIntentPath(userData))).toBe(false)
})

it('停止失败保留登录密文、失效标记及归属，显式重试使用同一份子树', async () => {
  const { logout, deps, credential, userData, processes } = fixture()
  deps.stop.mockRejectedValueOnce(new Error('still running'))
  await expect(logout.run()).rejects.toThrow('still running')
  expect(deps.release).not.toHaveBeenCalled()
  expect(deps.relaunch).not.toHaveBeenCalled()
  expect(fs.existsSync(credential)).toBe(true)
  expect(JSON.parse(fs.readFileSync(logoutIntentPath(userData), 'utf8')).processes).toEqual(processes)
  await logout.run()
  expect(deps.snapshot).toHaveBeenCalledTimes(1)
  expect(deps.seal).toHaveBeenCalledTimes(1)
  expect(deps.stop).toHaveBeenCalledTimes(2)
})

it('标记无法落盘时不开始清理；快照失败时不删除登录或释放归属', async () => {
  const { logout, deps, userData, credential } = fixture()
  fs.mkdirSync(logoutIntentPath(userData))
  await expect(logout.run()).rejects.toThrow()
  expect(logout.started()).toBe(false)
  expect(deps.seal).not.toHaveBeenCalled()
  fs.rmdirSync(logoutIntentPath(userData))
  deps.snapshot.mockImplementationOnce(() => {
    throw new Error('unknown')
  })
  await expect(logout.run()).rejects.toThrow('unknown')
  expect(fs.existsSync(credential)).toBe(true)
  expect(deps.release).not.toHaveBeenCalled()
  await logout.run()
  expect(deps.relaunch).toHaveBeenCalledTimes(1)
})

it('异步网关快照未完成时不停止或清除登录；拒绝后保留退出意图', async () => {
  const { logout, deps, credential, userData } = fixture()
  let fail!: (error: Error) => void
  deps.snapshot.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject
      })
  )
  const running = logout.run()
  expect(deps.stop).not.toHaveBeenCalled()
  expect(fs.existsSync(credential)).toBe(true)
  fail(new Error('gateway ownership unknown'))
  await expect(running).rejects.toThrow('ownership unknown')
  expect(fs.existsSync(logoutIntentPath(userData))).toBe(true)
  expect(deps.relaunch).not.toHaveBeenCalled()
})
