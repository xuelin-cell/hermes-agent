import { EventEmitter } from 'node:events'

import { beforeEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  spawn: vi.fn(),
  route: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => process.cwd(), getVersion: () => 'fixture' },
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => native.handlers.set(name, fn) }
}))
vi.mock('node-pty', () => ({ default: { spawn: native.spawn } }))
vi.mock('./connection-apply', () => ({ resolveTerminalConnectionForSender: native.route }))

import { registerTerminalIpc } from './terminal-ipc'

beforeEach(() => {
  vi.clearAllMocks()
  native.handlers.clear()
  native.route.mockResolvedValue(null)
})

/** 调用真实 IPC 处理器，只替换 OS PTY 与连接等待，观察是否仍然创建进程。 */
function fixture() {
  const pty = { pid: 123, onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() }
  native.spawn.mockReturnValue(pty)

  const api = registerTerminalIpc({
    isWindows: true,
    findOnPath: () => null,
    rememberLog: vi.fn(),
    activeSshTerminalTarget: () => null,
    ensureBackend: async () => null,
    getSshConnectionState: () => undefined
  })

  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: vi.fn() })

  return { api, pty, start: () => native.handlers.get('hermes:terminal:start')!({ sender }, {}) }
}

it('窗口销毁前交出 PTY 根；封闭后拒绝新终端，清理仍可重复执行', async () => {
  const { api, pty, start } = fixture()
  await start()
  expect(api.seal()).toEqual([123])
  await expect(start()).rejects.toThrow('账号正在退出')
  expect(native.spawn).toHaveBeenCalledTimes(1)
  api.disposeAllTerminalSessions()
  api.disposeAllTerminalSessions()
  expect(pty.kill).toHaveBeenCalledTimes(1)
  // 尚未 attach 的退出输出仍在缓存，但已退出的 PID 不能再当作归属。
  const next = fixture()
  await next.start()
  next.pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null })
  expect(next.api.seal()).toEqual([])
})

it('退出发生在连接等待期间，迟到回调不能再拉起 PTY', async () => {
  const { api, start } = fixture()
  let ready!: (value: null) => void
  native.route.mockReturnValueOnce(
    new Promise(resolve => {
      ready = resolve
    })
  )
  const pending = start()
  expect(api.seal()).toEqual([])
  ready(null)
  await expect(pending).rejects.toThrow('账号正在退出')
  expect(native.spawn).not.toHaveBeenCalled()
})
