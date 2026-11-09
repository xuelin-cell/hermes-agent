import { expect, it, vi } from 'vitest'

import { startAccountConnectors } from './connector-startup'

it.each(['connector', 'backend'])('先就绪的是 %s 时，两边都就绪后才刷新且不阻塞调用方', async first => {
  let ready!: () => void

  const start = vi.fn(
    () =>
      new Promise<void>(resolve => {
        ready = resolve
      })
  )

  const refresh = vi.fn(async () => undefined)

  const afterReady = startAccountConnectors({
    connectors: { start, refreshAll: refresh },
    active: () => true,
    log: vi.fn()
  })

  expect(start).toHaveBeenCalledOnce()
  expect(refresh).not.toHaveBeenCalled()

  if (first === 'connector') {
    ready()
    await Promise.resolve()
    expect(refresh).not.toHaveBeenCalled()
  }

  const pending = afterReady()
  expect(refresh).not.toHaveBeenCalled()
  ready()
  await pending
  expect(refresh).toHaveBeenCalledExactlyOnceWith()
})

it('账号或启动轮次已失效时不执行迟到配置刷新', async () => {
  let ready!: () => void
  let active = true

  const connectors = {
    start: () =>
      new Promise<void>(resolve => {
        ready = resolve
      }),
    refreshAll: vi.fn()
  }

  const afterReady = startAccountConnectors({ connectors, active: () => active, log: vi.fn() })
  const pending = afterReady()
  active = false
  ready()
  await pending
  expect(connectors.refreshAll).not.toHaveBeenCalled()
})

it.each(['start', 'refreshAll'] as const)('%s 失败只记录固定日志，不阻塞桌面也不泄露原始错误', async phase => {
  const connectors = { start: vi.fn(async () => undefined), refreshAll: vi.fn(async () => undefined) }
  connectors[phase].mockRejectedValue(new Error('PRIVATE-CREDENTIAL'))
  const log = vi.fn()
  const afterReady = startAccountConnectors({ connectors, active: () => true, log })
  await expect(afterReady()).resolves.toBeUndefined()
  expect(log).toHaveBeenCalledOnce()
  expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE')

  if (phase === 'start') {
    expect(connectors.refreshAll).not.toHaveBeenCalled()
  }
})
