import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { convertCom, officeComEnvironment, officePowerShellCandidates } from './convert-com'
import type { OfficeComProgram } from './detect'
import type { runOfficeProcess } from './run-process'

let fixture: string
let source: string

const program: OfficeComProgram = {
  kind: 'word',
  provider: 'ms-office',
  executable: process.execPath,
  registryView: '64',
  progId: 'Word.Application',
  command: process.execPath
}

const pdf = Buffer.from('%PDF-1.7\ncontrolled conversion output\n%%EOF\n')

beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-com-driver-'))
  source = path.join(fixture, "中文 '源文件'.docx")
  await fs.writeFile(source, 'controlled source')
})
afterEach(async () => {
  const relative = path.relative(os.tmpdir(), fixture)

  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.startsWith('hermes-com-driver-')) {
    throw new Error('Unsafe fixture cleanup')
  }

  await fs.rm(fixture, { recursive: true, force: true })
})

describe('COM driver', () => {
  it('selects matching Windows PowerShell architecture using paths as data', () => {
    expect(officePowerShellCandidates('32', 'X:\\Windows', 'x64')[0]).toContain('SysWOW64')
    expect(officePowerShellCandidates('64', 'X:\\Windows', 'ia32')[0]).toContain('Sysnative')
    expect(officePowerShellCandidates('64', 'X:\\Windows', 'x64')[0]).toContain('System32')
  })

  it('counts processes by program name, including the WPS component that may serve the COM class', () => {
    const wps = officeComEnvironment({
      ...program,
      provider: 'wps',
      kind: 'slides',
      progId: 'KWPP.Application',
      executable: 'D:\\WPS Office\\office6\\wps.exe'
    })

    expect(JSON.parse(wps.OFFICE_NAMES!)).toEqual(['wps', 'wpp'])
    const word = officeComEnvironment({ ...program, executable: 'C:\\Office\\WINWORD.EXE' })
    expect(JSON.parse(word.OFFICE_NAMES!)).toEqual(['winword'])
  })

  it.runIf(process.platform === 'win32')(
    'passes paths as environment data and starts no second PowerShell when the script confirms cleanup',
    async () => {
      const run = vi.fn<typeof runOfficeProcess>().mockImplementation(async (_file, _args, options) => {
        expect(options.env.OFFICE_SOURCE).toBe(source)
        await fs.writeFile(options.env.OFFICE_OWNER!, '{}')
        await fs.writeFile(options.env.OFFICE_PDF!, pdf)

        return { stdout: JSON.stringify({ ok: true, clean: true }) }
      })

      const result = await convertCom(program, source, fixture, 5000, run)
      expect(result.ok).toBe(true)

      if (result.ok) {
        expect(await fs.readFile(result.pdfPath)).toEqual(pdf)
      }

      expect(run).toHaveBeenCalledTimes(1)
      expect(run.mock.calls[0][2].timeoutMs).toBeLessThan(5000)
      expect(run.mock.calls[0][1].join(' ')).not.toContain(source)
      expect(await fs.readFile(source, 'utf8')).toBe('controlled source')
    }
  )

  it.runIf(process.platform === 'win32')(
    'runs the cleanup script only when the conversion script did not confirm, and stops fallback when it fails',
    async () => {
      // 脚本已经写下记录（启动过 Office）后超时。
      const started = async (_file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        await fs.writeFile(options.env.OFFICE_OWNER!, '{}')

        return { stdout: '', failure: 'timeout' as const }
      }

      const run = vi
        .fn<typeof runOfficeProcess>()
        .mockImplementationOnce(started)
        .mockResolvedValueOnce({ stdout: '{"ok":true}' })

      expect(await convertCom(program, source, fixture, 5000, run)).toEqual({
        ok: false,
        code: 'timeout',
        cleanupSafe: true
      })
      expect(run).toHaveBeenCalledTimes(2)
      expect(run.mock.calls[0][2].timeoutMs + run.mock.calls[1][2].timeoutMs).toBe(5000)

      run.mockReset().mockImplementationOnce(started).mockResolvedValueOnce({ stdout: '{"ok":false}' })
      expect(await convertCom(program, source, fixture, 5000, run)).toEqual({
        ok: false,
        code: 'timeout',
        cleanupSafe: false
      })
    }
  )

  it.runIf(process.platform === 'win32')(
    'treats a PowerShell that never started the script as safe to fall back from, without a cleanup run',
    async () => {
      const run = vi.fn<typeof runOfficeProcess>().mockResolvedValue({ stdout: '', failure: 'convert_failed' })
      expect(await convertCom(program, source, fixture, 5000, run)).toEqual({
        ok: false,
        code: 'convert_failed',
        cleanupSafe: true
      })
      expect(run).toHaveBeenCalledTimes(1)
    }
  )

  it.runIf(process.platform === 'win32')(
    'fails an encrypted package at once instead of letting Office wait on a password prompt',
    async () => {
      const run = vi.fn<typeof runOfficeProcess>()
      await fs.writeFile(source, Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(504)]))
      expect(await convertCom(program, source, fixture, 5000, run)).toEqual({
        ok: false,
        code: 'convert_failed',
        cleanupSafe: true
      })
      expect(run).not.toHaveBeenCalled()
    }
  )

  it.runIf(process.platform === 'win32')(
    'keeps a missing source, an unsupported format and a missing work directory apart',
    async () => {
      const run = vi.fn<typeof runOfficeProcess>()
      expect(await convertCom(program, source + '.docx', fixture, 5000, run)).toEqual({
        ok: false,
        code: 'not_found',
        cleanupSafe: true
      })
      expect(await convertCom(program, source + '.txt', fixture, 5000, run)).toEqual({
        ok: false,
        code: 'unsupported',
        cleanupSafe: true
      })
      expect(await convertCom(program, source, path.join(fixture, 'missing'), 5000, run)).toEqual({
        ok: false,
        code: 'convert_failed',
        cleanupSafe: true
      })
      expect(run).not.toHaveBeenCalled()
    }
  )
})
