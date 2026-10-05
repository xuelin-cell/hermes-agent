import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, expect, it, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: execute }))
vi.mock('./desktop-environment', () => ({
  accountDesktopEnvironment: () => ({ HERMES_HOME: 'fixed-account' }),
  accountSourceBackend: () => ({ command: 'fixed-python', env: { HERMES_HOME: 'fixed-account' } })
}))

import { type AccountGateway, createAccountGatewayLogout, gatewayLogoutRoots } from './gateway-logout'
import type { PreparedLocalContext } from './runtime-context'

const gateway: AccountGateway = {
  pid: 42, created: 1_700_000_000, home: 'fixed-account', launcher: false, external: false
}

const context = { installationRoot: 'C:/fixed-source' } as PreparedLocalContext
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

/** 用真实逐行管道模拟辅助进程，只控制应答或断开，不绕过生产校验。 */
function fixture() {
  const events = new EventEmitter()

  const child = Object.assign(events, {
    stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(() => events.emit('close', 0))
  })

  child.stdin.on('finish', () => events.emit('close', 0))

  execute.mockReturnValueOnce(child)
  const requests: { operation: string; saved: AccountGateway[] }[] = []
  child.stdin.on('data', data => requests.push(JSON.parse(data.toString())))

  return { child, requests, adapter: createAccountGatewayLogout(context) }
}

it('同一次退出复用一个辅助进程，共享快照不泄露命令行，停止和终检分别读取应答', async () => {
  const f = fixture()
  const snapshot = { processes: [{ pid: 42, parent: 1, started: '638355968000000000' }], gateways: [gateway] }

  try {
    const reading = f.adapter.run('snapshot')
    const text = JSON.stringify(snapshot)
    f.child.stdout.write(text.slice(0, 10))
    f.child.stdout.write(text.slice(10) + '\n')
    expect(await reading).toEqual(snapshot)

    for (const operation of ['stop', 'check'] as const) {
      const request = f.adapter.run(operation, [gateway])
      f.child.stdout.write('{"processes":[],"gateways":[]}\n')
      expect(await request).toEqual({ processes: [], gateways: [] })
    }

    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith('fixed-python', [expect.stringContaining('gateway-logout.py')],
      expect.objectContaining({ windowsHide: true, env: { HERMES_HOME: 'fixed-account' } }))
    expect(f.requests).toEqual([
      { operation: 'snapshot', saved: [] }, { operation: 'stop', saved: [gateway] }, { operation: 'check', saved: [gateway] }
    ])
  } finally { await f.adapter.dispose() }

  expect(f.child.stdin.writableEnded).toBe(true)
  expect(f.child.kill).not.toHaveBeenCalled()
})

it('坏指纹、额外秘密、异常断开与超时均拒绝放行；新尝试使用新进程', async () => {
  for (const response of [
    { error: true }, { processes: [], gateways: [{ ...gateway, pid: -1 }] },
    { processes: [{ pid: 42, parent: 1, started: '123', command: 'private-key' }], gateways: [] }
  ]) {
    const f = fixture()
    const rejection = expect(f.adapter.run('snapshot')).rejects.toThrow('请重试')
    f.child.stdout.write(JSON.stringify(response) + '\n')
    await rejection
    expect(f.child.stdin.writableEnded).toBe(true)
    await expect(f.adapter.run('check')).rejects.toThrow('请重试')
  }

  const broken = fixture()
  const disconnected = expect(broken.adapter.run('stop')).rejects.toThrow('请重试')
  broken.child.emit('exit', 1)
  await disconnected

  vi.useFakeTimers()
  const slow = fixture()
  slow.child.stdin.removeAllListeners('finish')
  const timeout = expect(slow.adapter.run('snapshot')).rejects.toThrow('请重试')
  await vi.advanceTimersByTimeAsync(90_000)
  await timeout
  await vi.advanceTimersByTimeAsync(7_000)
  expect(slow.child.kill).toHaveBeenCalledTimes(1)
})

it('原生创建时间匹配才纳入子树，退出和 PID 重用不会扩大停止范围', () => {
  const started = (621355968000000000n + BigInt(gateway.created) * 10_000_000n).toString()
  expect(gatewayLogoutRoots([gateway], [{ pid: 42, parent: 1, started }])).toEqual([42])
  expect(gatewayLogoutRoots([gateway], [])).toEqual([])
  expect(
    gatewayLogoutRoots([gateway], [{ pid: 42, parent: 1, started: (BigInt(started) + 10_000_000n).toString() }])
  ).toEqual([])
  expect(() => gatewayLogoutRoots([gateway], [{ pid: 42, parent: 1, started: '' }])).toThrow('创建时间')
})
