import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

import { createAccountGatewayLogout } from './gateway-logout'
import type { PreparedLocalContext } from './runtime-context'

it.skipIf(process.platform !== 'win32')('真实 TypeScript 子进程保留账号完整环境，原版 source-backend 的增量环境不能替代它', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-gateway-bridge-'))
  const source = path.resolve(import.meta.dirname, '../../../..')

  const context: PreparedLocalContext = {
    id: 'test-account', home: path.join(root, 'home'), workspace: path.join(root, 'workspace'),
    desktopState: path.join(root, 'desktop'), installationRoot: source,
    python: path.join(source, '.venv/Scripts/python.exe')
  }

  fs.mkdirSync(context.home)
  fs.writeFileSync(path.join(context.home, 'history-sentinel.txt'), 'keep')

  const gateway = createAccountGatewayLogout(context)
  let unrelated: ReturnType<typeof spawn> | undefined

  try {
    const snapshot = await gateway.run('snapshot')
    expect(snapshot.gateways).toEqual([])
    expect(snapshot.processes.find(row => row.pid === process.pid)?.started).toMatch(/^\d+$/)
    expect(snapshot.processes.every(row => Object.keys(row).sort().join() === 'parent,pid,started')).toBe(true)
    unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true })
    await once(unrelated, 'spawn')
    expect(snapshot.processes.some(row => row.pid === unrelated!.pid)).toBe(false)
    expect((await gateway.run('snapshot')).processes.some(row => row.pid === unrelated!.pid)).toBe(true)
    expect(await gateway.run('stop')).toEqual({ processes: [], gateways: [] })
    expect(await gateway.run('check')).toEqual({ processes: [], gateways: [] })
    expect(unrelated.exitCode).toBe(null)
    expect(fs.readFileSync(path.join(context.home, 'history-sentinel.txt'), 'utf8')).toBe('keep')
  } finally {
    await gateway.dispose()

    if (unrelated && unrelated.exitCode === null && unrelated.signalCode === null) {
      const exited = once(unrelated, 'close')
      unrelated.kill()
      await exited
    }

    fs.rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
