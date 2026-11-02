import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import type * as logoutProcesses from './logout-processes'

const fake = vi.hoisted(() => ({ list: vi.fn(), stop: vi.fn(), probe: vi.fn(), gateway: vi.fn(), alive: vi.fn() }))
vi.mock('electron', () => ({ safeStorage: {} }))
vi.mock('../backend-claim', () => ({ processStartMarker: fake.probe, REAP_PROBE_TIMEOUT_MS: 5000 }))
vi.mock('../source-python', () => ({ resolveSourcePython: () => process.execPath }))
vi.mock('../update-marker', () => ({ isPidAlive: fake.alive }))
vi.mock('./gateway-logout', () => ({
  createAccountGatewayLogout: () => ({ run: fake.gateway, dispose: vi.fn() }),
  gatewayLogoutRoots: () => []
}))
vi.mock('./logout-processes', async importOriginal => ({
  ...(await importOriginal<typeof logoutProcesses>()),
  listLogoutProcesses: fake.list,
  stopLogoutProcesses: fake.stop
}))

import { prepareAccountPaths } from './account-paths'
import { logoutIntentPath, recordAccountRun } from './logout'
import { recoverAccountRun } from './recover-account'

const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** 真实临时记录搭配受控系统探针，区分原后端、子进程和复用同一 PID 的无关进程。 */
function fixture() {
  vi.resetAllMocks()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-recover-'))
  temporary.push(root)
  const roots = { data: path.join(root, 'data'), userData: path.join(root, 'user-data') }
  const account = prepareAccountPaths(roots, 'fixture-platform', 'fixture-user')
  const marker = logoutIntentPath(roots.userData)
  recordAccountRun(roots.userData, account.id)
  const credential = path.join(roots.userData, 'maas-login.enc')
  fs.writeFileSync(credential, 'encrypted-record-sentinel')
  const history = path.join(account.home, 'state.db')
  fs.writeFileSync(history, 'history-sentinel')
  const ownershipFile = path.join(account.desktopState, 'backend-ownership.json')

  const backends = [
    { pid: 10, nonce: 'root', profile: 'default', startMarker: 'win:1000', parentPid: 1, parentStartMarker: 'win:1' },
    { pid: 12, nonce: 'old', profile: 'default', startMarker: 'win:900', parentPid: 1, parentStartMarker: 'win:1' }
  ]

  fs.writeFileSync(ownershipFile, JSON.stringify({ backends }))
  // 低号 PID 在真实系统上几乎必死；fixtures 需要它们按存活路径走。
  fake.alive.mockImplementation(pid => pid === 10 || pid === 12)
  fake.list.mockReturnValue([
    { pid: 10, parent: 1, started: '1000' },
    { pid: 11, parent: 10, started: '1001' },
    { pid: 12, parent: 1, started: '1500' }
  ])
  fake.probe.mockImplementation(async pid => (pid === 10 ? 'win:1000' : 'win:1500'))
  fake.gateway.mockResolvedValue({ processes: [], gateways: [] })
  const run = () => recoverAccountRun(roots, root)

  return { root, roots, account, marker, credential, history, ownershipFile, backends, run }
}

it('重开先保存可信子树；停止失败保留证据，完成后遵循退出方式且跳过复用 PID', async () => {
  for (const mode of ['quit', 'logout']) {
    const f = fixture()
    fs.writeFileSync(f.marker, JSON.stringify({ account: f.account.id, mode }))
    const ownership = fs.readFileSync(f.ownershipFile)
    fake.stop.mockImplementationOnce(() => {
      throw new Error('still running')
    })
    await expect(f.run()).rejects.toThrow('still running')
    const pending = fs.readFileSync(f.marker)
    const processes = JSON.parse(pending.toString()).processes
    expect(processes.map(row => row.pid)).toEqual([10, 11])
    expect(fs.readFileSync(f.ownershipFile)).toEqual(ownership)
    expect(fs.readFileSync(f.credential, 'utf8')).toBe('encrypted-record-sentinel')

    // 父后端后来已退出，重开仍使用上轮持久记录处理失去父进程的叶子。
    fake.list.mockReturnValue([
      { pid: 11, parent: 10, started: '1001' },
      { pid: 12, parent: 1, started: '1500' }
    ])
    await f.run()
    expect(fake.stop).toHaveBeenLastCalledWith(processes)
    expect(fs.existsSync(f.marker)).toBe(false)
    expect(JSON.parse(fs.readFileSync(f.ownershipFile, 'utf8')).backends).toEqual([])
    expect(fs.existsSync(f.credential)).toBe(mode === 'quit')
    expect(fs.readFileSync(f.history, 'utf8')).toBe('history-sentinel')
    const calls = fake.stop.mock.calls.length
    await f.run()
    expect(fake.stop).toHaveBeenCalledTimes(calls)
  }
})

it('后端 PID 全部已死或被复用时，恢复不触发进程表查询也不探测（冷启动 PowerShell 会卡死启动期恢复）', async () => {
  // 回归：旧代码无条件先跑 CIM 全表查询，Electron 冷启动 spawn 实测 ~16s，
  // 系统繁忙时两次 30s 超时即弹窗阻断登录；已死 PID 只需零成本的原生探测。
  const f = fixture()
  fake.alive.mockImplementation(() => false)
  await f.run()
  expect(fake.list).not.toHaveBeenCalled()
  expect(fake.probe).not.toHaveBeenCalled()
  // 空清单调用是元操作：无存活进程时不应付出任何 taskkill。
  expect(fake.stop).toHaveBeenCalledWith([])
  expect(fs.existsSync(f.marker)).toBe(false)
  expect(JSON.parse(fs.readFileSync(f.ownershipFile, 'utf8')).backends).toEqual([])
})

it('复用 PID 只核指纹不拉进程表，且探测不用可放弃的 5s REAP 预算', async () => {
  const f = fixture()
  fake.probe.mockImplementation(async () => 'win:9999')
  await f.run()
  expect(fake.probe).toHaveBeenCalledWith(10)
  expect(fake.probe).toHaveBeenCalledWith(12)
  expect(fake.list).not.toHaveBeenCalled()
  expect(fs.existsSync(f.marker)).toBe(false)
})

it('坏记录、越界路径、未知指纹或活父实例均阻止清理且保留原件', async () => {
  for (const fault of [
    'bad-marker',
    'path',
    'bad-roster',
    'partial-roster',
    'unknown',
    'parent',
    'parent-ms',
    'probe',
    'junction',
    'owner'
  ]) {
    const f = fixture()

    if (fault === 'bad-marker') {
      fs.writeFileSync(f.marker, '{')
    }

    if (fault === 'path') {
      fs.writeFileSync(f.marker, JSON.stringify({ account: '../outside', mode: 'quit' }))
    }

    if (fault === 'bad-roster') {
      fs.writeFileSync(f.ownershipFile, '{')
    }

    if (fault === 'partial-roster') {
      fs.writeFileSync(f.ownershipFile, JSON.stringify({ backends: [...f.backends, { pid: 99 }] }))
    }

    if (fault === 'unknown') {
      fs.writeFileSync(
        f.ownershipFile,
        JSON.stringify({ backends: [{ ...f.backends[0], startMarker: 'pid-only:10' }] })
      )
    }

    if (fault === 'parent') {
      fake.list.mockReturnValue([...fake.list(), { pid: 1, parent: 0, started: '1' }])
    }

    if (fault === 'parent-ms') {
      fs.writeFileSync(
        f.ownershipFile,
        JSON.stringify({ backends: [{ ...f.backends[0], parentStartMarker: 'winms:1700000000000' }] })
      )
      fake.list.mockReturnValue([...fake.list(), { pid: 1, parent: 0, started: '638355968000000000' }])
    }

    if (fault === 'probe') {
      fake.probe.mockRejectedValue(new Error('probe unavailable'))
    }

    if (fault === 'owner') {
      // 摘要前 12 位相同的另一账号占用目录时，不能按本账号记录处理进程。
      fs.writeFileSync(path.join(path.dirname(f.account.desktopState), 'account-id'), `account-${'0'.repeat(64)}`)
    }

    if (fault === 'junction') {
      const parked = `${f.account.home}-saved`
      fs.renameSync(f.account.home, parked)
      fs.symlinkSync(parked, f.account.home, 'junction')
    }

    const marker = fs.readFileSync(f.marker)
    const ownership = fs.readFileSync(f.ownershipFile)
    await expect(f.run()).rejects.toThrow()
    expect(fake.stop).not.toHaveBeenCalled()
    expect(fake.gateway).not.toHaveBeenCalled()
    expect(fs.readFileSync(f.marker)).toEqual(marker)
    expect(fs.readFileSync(f.ownershipFile)).toEqual(ownership)
    expect(fs.readFileSync(f.credential, 'utf8')).toBe('encrypted-record-sentinel')
  }
})
