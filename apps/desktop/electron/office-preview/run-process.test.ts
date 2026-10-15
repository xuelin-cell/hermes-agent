import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { runOfficeProcess } from './run-process'

const options = { cwd: os.tmpdir(), env: process.env, timeoutMs: 5000 }

describe('bounded Office helper', () => {
  it('executes an isolated real helper and returns its output after exit', async () => {
    const result = await runOfficeProcess(process.execPath, ['-e', 'process.stdout.write("ready")'], options)
    expect(result).toEqual({ stdout: 'ready', failure: undefined })
  })

  it('limits output and distinguishes overflow, timeout and missing executable', async () => {
    const overflow = await runOfficeProcess(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(100000))'],
      options
    )

    expect(overflow.failure).toBe('convert_failed')

    const timeout = await runOfficeProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      ...options,
      timeoutMs: 2000
    })

    expect(timeout).toMatchObject({ failure: 'timeout', stopped: true })
    expect((await runOfficeProcess('nonexistent-office-helper-20261013', [], options)).failure).toBe('unavailable')
  })

  it.runIf(process.platform === 'win32')(
    'stops the real worker started by a launcher on timeout, like soffice.com starting soffice.bin',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-office-tree-'))

      try {
        const pidFile = path.join(root, 'worker.pid')
        const worker = path.join(root, 'worker.js')
        const launcher = path.join(root, 'launcher.cmd')
        await fs.writeFile(
          worker,
          `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
        )
        // 批处理只负责启动并等待工作进程，和 soffice.com 一样不会替子进程收尾。
        await fs.writeFile(launcher, `@echo off\r\n"${process.execPath}" "${worker}"\r\n`)

        const result = await runOfficeProcess(process.env.ComSpec || 'cmd.exe', ['/d', '/c', launcher], {
          ...options,
          cwd: root,
          timeoutMs: 3000
        })

        expect(result).toMatchObject({ failure: 'timeout', stopped: true })
        const pid = Number(await fs.readFile(pidFile, 'utf8'))
        expect(() => process.kill(pid, 0)).toThrow()
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    },
    20_000
  )
})
