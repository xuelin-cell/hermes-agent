import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

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

it.runIf(process.platform === 'darwin')('macOS 网关缺失 PID 文件时仍按真实身份停止，另一账号和历史文件保留', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-gateway-missing-pid-'))
  const source = path.resolve(import.meta.dirname, '../../../..')
  const python = path.join(source, '.venv/bin/python')
  const home = path.join(root, 'account-a')
  const foreignHome = path.join(root, 'account-b')
  const fixture = path.join(root, 'hermes_cli')
  fs.mkdirSync(fixture)
  fs.mkdirSync(home)
  fs.mkdirSync(foreignHome)
  fs.writeFileSync(path.join(home, 'history-sentinel.txt'), 'keep')
  fs.writeFileSync(path.join(fixture, '__init__.py'), '')
  fs.writeFileSync(path.join(fixture, 'main.py'),
    "import os, pathlib, time\npathlib.Path(os.environ['HERMES_HOME'], 'ready').touch()\ntime.sleep(120)\n")
  const children = [home, foreignHome].map(accountHome => spawn(python,
    ['-m', 'hermes_cli.main', 'gateway', 'run'], {
      cwd: root, env: { ...process.env, HERMES_HOME: accountHome, PYTHONPATH: root }, stdio: 'ignore'
    }))
  const gateway = createAccountGatewayLogout({
    id: 'test-account', home, workspace: root, desktopState: root, installationRoot: source, python
  })

  try {
    const deadline = Date.now() + 10_000
    while (![home, foreignHome].every(dir => fs.existsSync(path.join(dir, 'ready'))) && Date.now() < deadline) {
      await delay(50)
    }
    expect([home, foreignHome].every(dir => fs.existsSync(path.join(dir, 'ready')))).toBe(true)
    expect(fs.existsSync(path.join(home, 'gateway.pid'))).toBe(false)
    const snapshot = await gateway.run('snapshot')
    expect(snapshot.gateways.map(row => row.pid)).toEqual([children[0].pid])
    await gateway.run('stop', snapshot.gateways)
    await gateway.run('check')
    expect(() => process.kill(children[0].pid!, 0)).toThrow()
    process.kill(children[1].pid!, 0)
    expect(fs.readFileSync(path.join(home, 'history-sentinel.txt'), 'utf8')).toBe('keep')
  } finally {
    await gateway.dispose()
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close')
        child.kill()
        await closed
      }
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
