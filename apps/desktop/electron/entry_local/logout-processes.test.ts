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

it('每次停止带创建时间条件；同 PID 新实例视为无关，存活旧实例阻止成功', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const owned = [{ pid: 123, parent: 1, started: '100' }]
  exec.mockReturnValueOnce('').mockReturnValueOnce(JSON.stringify([{ ...owned[0], started: '200' }]))
  stopLogoutProcesses(owned)
  expect(exec.mock.calls[0][1].at(-1)).toContain("-eq '100'")
  expect(exec.mock.calls[0][2]).toMatchObject({ windowsHide: true, timeout: 15_000 })
  exec.mockReturnValueOnce('').mockReturnValueOnce(JSON.stringify(owned))
  expect(() => stopLogoutProcesses(owned)).toThrow('尚未停止')
  vi.restoreAllMocks()
})
