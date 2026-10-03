import { expect, it, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execute }))
vi.mock('./desktop-environment', () => ({
  accountDesktopEnvironment: () => ({ HERMES_HOME: 'fixed-account' }),
  accountSourceBackend: () => ({ command: 'fixed-python', env: { HERMES_HOME: 'fixed-account' } })
}))

import { type AccountGateway, accountGatewayLogout, gatewayLogoutRoots } from './gateway-logout'
import type { PreparedLocalContext } from './runtime-context'

const gateway: AccountGateway = {
  pid: 42,
  created: 1_700_000_000,
  home: 'fixed-account',
  launcher: false,
  external: false
}

const context = { installationRoot: 'C:/fixed-source' } as PreparedLocalContext

it('只调用固定一次性脚本，凭据不进参数；停止归属由主进程标准输入传递', async () => {
  const end = vi.fn()
  execute.mockImplementationOnce((_command, _args, _options, callback) => {
    callback(null, JSON.stringify([gateway]))

    return { stdin: { end } }
  })
  expect(await accountGatewayLogout(context, 'stop', [gateway])).toEqual([gateway])
  expect(execute).toHaveBeenLastCalledWith(
    'fixed-python',
    [expect.stringContaining('gateway-logout.py'), 'stop'],
    expect.objectContaining({ windowsHide: true, timeout: 90_000, env: { HERMES_HOME: 'fixed-account' } }),
    expect.any(Function)
  )
  expect(end).toHaveBeenCalledWith(JSON.stringify([gateway]))
})

it('脚本失败或返回坏身份不放行，原始 stderr 和命令不会透传页面', async () => {
  execute.mockImplementationOnce((_command, _args, _options, callback) => {
    callback(new Error('secret fixture'), '', 'private stderr')

    return {}
  })
  await expect(accountGatewayLogout(context, 'stop')).rejects.toThrow('请重试')
  execute.mockImplementationOnce((_command, _args, _options, callback) => {
    callback(null, JSON.stringify([{ ...gateway, pid: -1 }]))

    return {}
  })
  await expect(accountGatewayLogout(context, 'snapshot')).rejects.toThrow('归属检查失败')
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
