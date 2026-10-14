import os from 'node:os'

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

    expect(timeout.failure).toBe('timeout')
    expect((await runOfficeProcess('nonexistent-office-helper-20261013', [], options)).failure).toBe('unavailable')
  })
})
