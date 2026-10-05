import { expect, it, vi } from 'vitest'

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: exec }))

import { logoutProcessTree, stopLogoutProcesses } from './logout-processes'

it('只选择所持有后端的后代，排除官方进程与父 PID 被复用前的旧子进程', () => {
  const rows = [
    { pid: 10, parent: 1, started: '100' },
    { pid: 11, parent: 10, started: '110' },
    { pid: 12, parent: 11, started: '120' },
    { pid: 13, parent: 10, started: '90' },
    { pid: 20, parent: 1, started: '100' }
  ]

  expect(logoutProcessTree(rows, [10]).map(row => row.pid)).toEqual([10, 11, 12])
  expect(() => logoutProcessTree(rows, [30])).toThrow()
})

it('批量停止只启动一次外部命令；同 PID 新实例无关，存活旧实例阻止成功', () => {
  vi.spyOn(process, 'kill').mockReturnValue(true)
  exec.mockClear()
  const owned = [{ pid: 123, parent: 1, started: '100' }, { pid: 124, parent: 123, started: '110' }]
  exec.mockReturnValueOnce(JSON.stringify([{ ...owned[0], started: '200' }]))
  stopLogoutProcesses(owned)
  expect(exec).toHaveBeenCalledTimes(1)
  expect(exec.mock.calls[0][2]).toMatchObject({ windowsHide: true, timeout: 15_000 })
  exec.mockReturnValueOnce(JSON.stringify(owned))
  expect(() => stopLogoutProcesses(owned)).toThrow('尚未停止')
  exec.mockReturnValueOnce(JSON.stringify([{ pid: 123, started: '' }]))
  expect(() => stopLogoutProcesses(owned)).toThrow('尚未停止')
  vi.restoreAllMocks()
})

it('原版已停止全部进程时不启动清理程序；无法确认的探测不能当作已退出', () => {
  exec.mockClear()

  const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' })
  })

  const owned = [{ pid: 123, parent: 1, started: '100' }]

  stopLogoutProcesses(owned)
  expect(probe).toHaveBeenCalledWith(123, 0)
  expect(exec).not.toHaveBeenCalled()

  probe.mockImplementation(() => { throw Object.assign(new Error('unknown'), { code: 'EIO' }) })
  expect(() => stopLogoutProcesses(owned)).toThrow('无法确认')
  expect(exec).not.toHaveBeenCalled()

  probe.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
  exec.mockReturnValueOnce(JSON.stringify(owned))
  expect(() => stopLogoutProcesses(owned)).toThrow('尚未停止')
  expect(exec).toHaveBeenCalledTimes(1)
  vi.restoreAllMocks()
})
