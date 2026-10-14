import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OFFICE_PDF_MAX_BYTES, OFFICE_SOURCE_MAX_BYTES } from '../../../shared/src/office-preview'

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

  it('limits WPS hosts to the selected installation and gives only real Word and Excel classes standalone ownership', () => {
    const wps = officeComEnvironment({ ...program, provider: 'wps', kind: 'slides', progId: 'KWPP.Application' }, 'D:\\WPS Office\\office6\\wps.exe')
    expect(JSON.parse(wps.OFFICE_PATHS!)).toEqual(['D:\\WPS Office\\office6\\wpp.exe', 'D:\\WPS Office\\office6\\wps.exe'])
    expect(wps.OFFICE_STANDALONE).toBe('0')
    expect(officeComEnvironment(program, 'C:\\Office\\WINWORD.EXE').OFFICE_STANDALONE).toBe('1')
    expect(officeComEnvironment({ ...program, kind: 'slides', progId: 'PowerPoint.Application' }, 'C:\\Office\\POWERPNT.EXE').OFFICE_STANDALONE).toBe('0')
  })

  it.runIf(process.platform === 'win32')(
    'passes paths as environment data, reserves cleanup time and validates a real output file',
    async () => {
      const run = vi.fn<typeof runOfficeProcess>().mockImplementation(async (_file, _args, options) => {
        expect(options.env.OFFICE_SOURCE).toBe(source)

        if (run.mock.calls.length === 1) {
          await fs.writeFile(options.env.OFFICE_PDF!, pdf)

          return { stdout: JSON.stringify({ ok: true }) }
        }

        return { stdout: JSON.stringify({ ok: true }) }
      })

      const result = await convertCom(program, source, fixture, 5000, run)
      expect(result.ok).toBe(true)

      if (result.ok) {
        expect(await fs.readFile(result.pdfPath)).toEqual(pdf)
      }

      expect(run).toHaveBeenCalledTimes(2)
      expect(run.mock.calls[0][2].timeoutMs + run.mock.calls[1][2].timeoutMs).toBe(5000)
      expect(run.mock.calls[0][1]).not.toContain(source)
      expect(await fs.readFile(source, 'utf8')).toBe('controlled source')
    }
  )

  it.runIf(process.platform === 'win32')(
    'cleans after timeout and preserves an unsafe-cleanup signal instead of proceeding',
    async () => {
      const run = vi
        .fn<typeof runOfficeProcess>()
        .mockResolvedValueOnce({ stdout: '', failure: 'timeout' })
        .mockResolvedValueOnce({ stdout: '{"ok":true}' })

      expect(await convertCom(program, source, fixture, 5000, run)).toEqual({
        ok: false,
        code: 'timeout',
        cleanupSafe: true
      })
      run
        .mockReset()
        .mockResolvedValueOnce({ stdout: '', failure: 'timeout' })
        .mockResolvedValueOnce({ stdout: '{"ok":false}' })
      expect(await convertCom(program, source, fixture, 5000, run)).toEqual({
        ok: false,
        code: 'timeout',
        cleanupSafe: false
      })
    }
  )

  it.runIf(process.platform === 'win32')(
    'rejects missing output and non-PDF data after a successful cleanup',
    async () => {
      const run = vi.fn<typeof runOfficeProcess>().mockResolvedValue({ stdout: '{"ok":true}' })
      expect(await convertCom(program, source, fixture, 5000, run)).toEqual({
        ok: false,
        code: 'convert_failed',
        cleanupSafe: true
      })
      run.mockImplementation(async (_file, _args, options) => {
        await fs.writeFile(options.env.OFFICE_PDF!, 'not PDF')

        return { stdout: '{"ok":true}' }
      })
      expect(await convertCom(program, source, fixture, 5000, run)).toEqual({
        ok: false,
        code: 'convert_failed',
        cleanupSafe: true
      })
    }
  )

  it.runIf(process.platform === 'win32')(
    'rejects oversized PDF and oversized source without publishing or starting unnecessary helpers',
    async () => {
      const run = vi.fn<typeof runOfficeProcess>().mockImplementation(async (_file, _args, options) => {
        const file = await fs.open(options.env.OFFICE_PDF!, 'w')
        await file.truncate(OFFICE_PDF_MAX_BYTES + 1)
        await file.close()

        return { stdout: '{"ok":true}' }
      })

      expect(await convertCom(program, source, fixture, 5000, run)).toEqual({
        ok: false,
        code: 'too_large',
        cleanupSafe: true
      })
      run.mockClear()
      const file = await fs.open(source, 'w')
      await file.truncate(OFFICE_SOURCE_MAX_BYTES + 1)
      await file.close()
      expect(await convertCom(program, source, fixture, 5000, run)).toEqual({
        ok: false,
        code: 'too_large',
        cleanupSafe: true
      })
      expect(run).not.toHaveBeenCalled()
    }
  )

  it.runIf(process.platform === 'win32')(
    'keeps unavailable software distinct from a missing source or unsupported format',
    async () => {
      const run = vi.fn<typeof runOfficeProcess>()
      expect(
        await convertCom({ ...program, executable: path.join(fixture, 'missing.exe') }, source, fixture, 5000, run)
      ).toEqual({ ok: false, code: 'unavailable', cleanupSafe: true })
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
      expect(run).not.toHaveBeenCalled()
    }
  )
})
