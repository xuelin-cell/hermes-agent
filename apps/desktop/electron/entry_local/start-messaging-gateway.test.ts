import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn }))

import { startAccountMessagingGateway } from './start-messaging-gateway'

it('从账号工作区启动既定 Python 的原生 gateway run，保留账号环境、不强制接管，创建失败可观察', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-5g-start-'))

  const context = {
    id: 'account-A',
    home: path.join(root, 'home'),
    workspace: path.join(root, 'workspace'),
    desktopState: path.join(root, 'desktop'),
    installationRoot: path.resolve(import.meta.dirname, '../../../..'),
    python: path.join(root, 'python.exe'),
    sitePackages: path.join(root, 'deps')
  }

  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  spawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.emit('spawn')
      child.emit('close', 0)
    })

    return child
  })

  try {
    await startAccountMessagingGateway(context)
    expect(child.unref).toHaveBeenCalledOnce()
    const [command, args, options] = spawn.mock.calls[0]
    expect(command).toBe(context.python)
    expect(args.slice(-4)).toEqual(['-m', 'hermes_cli.main', 'gateway', 'run'])

    if (process.platform === 'win32') {
      expect(args[0]).toBe('-c')
      expect(args[2]).toBe(context.python)
    }

    expect(options).toMatchObject({
      cwd: context.workspace,
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: {
        HERMES_HOME: context.home,
        TERMINAL_CWD: context.workspace,
        PYTHONPATH: [context.installationRoot, context.sitePackages].join(path.delimiter)
      }
    })
    expect(options.env.HERMES_GATEWAY_LOCK_DIR).toBe(path.join(context.home, 'gateway-locks'))

    if (process.platform === 'win32') {
      const failedLaunch = Object.assign(new EventEmitter(), { unref: vi.fn() })
      spawn.mockImplementationOnce(() => {
        queueMicrotask(() => {
          failedLaunch.emit('spawn')
          failedLaunch.emit('close', 1)
        })

        return failedLaunch
      })
      await expect(startAccountMessagingGateway(context)).rejects.toThrow('当前账号消息网关无法启动')
    }

    const failed = new EventEmitter()
    spawn.mockImplementationOnce(() => {
      queueMicrotask(() => failed.emit('error', new Error('private-path')))

      return failed
    })
    await expect(startAccountMessagingGateway(context)).rejects.toThrow('当前账号消息网关无法启动')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
