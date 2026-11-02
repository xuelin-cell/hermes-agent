import { expect, it, vi } from 'vitest'

import type { NtfyInstruction } from './contract'

const mock = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  options: undefined as { onInstruction: (instruction: NtfyInstruction) => void } | undefined
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, callback: (...args: unknown[]) => unknown) => mock.handles.set(name, callback) },
  powerMonitor: { on: vi.fn() }
}))
vi.mock('../desktop-renderer-sender', () => ({ isDesktopRendererSender: () => true }))
vi.mock('./token', () => ({ NtfyTokenClient: class {} }))
vi.mock('./subscriber', () => ({
  NtfySubscriber: class {
    /** 仅捕获订阅边界；IPC的事件转发和刷新编排保持真实。 */
    constructor(options: { onInstruction: (instruction: NtfyInstruction) => void }) {
      mock.options = options
    }
    /** 夹具不建立真实订阅，仅验证IPC转发。 */
    start() {}
    /** 夹具提供稳定状态，不把网络连接纳入此测试。 */
    statusSnapshot() {
      return { state: 'stopped' }
    }
  }
}))

import { NTFY_EVENT_CHANNEL, NTFY_START_CHANNEL } from './contract'
import { installNtfyIpc } from './ipc'

it('搜索刷新等待或失败时仍立即转发通知，且不回显异常原文', async () => {
  let reject!: (error: Error) => void

  const pending = new Promise<boolean>((_, fail) => {
    reject = fail
  })

  const refreshTools = vi.fn(() => pending)
  const log = vi.fn()
  installNtfyIpc({} as never, () => 'fixture', {
    identity: () => null,
    log,
    refresh: async () => ({ status: 'skipped' }),
    refreshTools
  })
  const send = vi.fn()
  mock.handles.get(NTFY_START_CHANNEL)!({ sender: { id: 1, once: vi.fn(), isDestroyed: () => false, send } })
  const instruction = { tags: ['refresh_tool_config', 'other'] } as NtfyInstruction
  mock.options!.onInstruction(instruction)
  expect(send).toHaveBeenCalledWith(NTFY_EVENT_CHANNEL, { instruction, kind: 'instruction' })
  await Promise.resolve()
  expect(refreshTools).toHaveBeenCalledTimes(1)
  reject(new Error('private-fixture-value'))
  await vi.waitFor(() => expect(log).toHaveBeenCalled())
  expect(log).toHaveBeenCalledWith('ntfy 搜索配置刷新失败，保留原配置')
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-fixture-value')
})
