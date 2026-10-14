import fs from 'node:fs/promises'
import path from 'node:path'

import {
  OFFICE_PDF_MAX_BYTES,
  OFFICE_SOURCE_MAX_BYTES,
  OFFICE_TIMEOUT_MS,
  officeDocumentKind,
  type OfficePreviewFailureCode
} from '../../../shared/src/office-preview'

import { OFFICE_COM_CLEANUP, officeComScript } from './com-scripts'
import type { OfficeComProgram, OfficeRegistryView } from './detect'
import { runOfficeProcess } from './run-process'

export interface ComConversionSuccess {
  ok: true
  pdfPath: string
}
export interface ComConversionFailure {
  ok: false
  code: OfficePreviewFailureCode
  cleanupSafe: boolean
}
export type ComConversionResult = ComConversionSuccess | ComConversionFailure

/** 选择与 COM 注册位数相同的系统 PowerShell，避免 32 位 WPS 被送到 64 位入口。 */
export function officePowerShellCandidates(view: OfficeRegistryView, systemRoot: string, arch: string): string[] {
  const directories =
    view === '32' ? ['SysWOW64', 'System32'] : arch === 'ia32' ? ['Sysnative', 'System32'] : ['System32']

  return directories.map(directory =>
    path.win32.join(systemRoot, directory, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  )
}

/** 只读取辅助脚本最后一行结果；不将异常文本或内部路径交给前端。 */
function scriptResult(stdout: string): { ok: boolean; code?: OfficePreviewFailureCode } {
  try {
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || '')

    return result && typeof result.ok === 'boolean' ? result : { ok: false }
  } catch {
    return { ok: false }
  }
}

/** 将探测到的 COM 程序用于实际转换，清理不确定时保留目录并要求上层停止降级。 */
export async function convertCom(
  program: OfficeComProgram,
  source: string,
  workDirectory: string,
  timeoutMs = OFFICE_TIMEOUT_MS,
  run: typeof runOfficeProcess = runOfficeProcess
): Promise<ComConversionResult> {
  if (process.platform !== 'win32') {
    return { ok: false, code: 'unavailable', cleanupSafe: true }
  }

  const kind = officeDocumentKind(source)

  if (!kind || kind !== program.kind) {
    return { ok: false, code: 'unsupported', cleanupSafe: true }
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 1) {
    return { ok: false, code: 'timeout', cleanupSafe: true }
  }

  let env: NodeJS.ProcessEnv | undefined
  let powershell: string | undefined
  let cleanupSafe = true
  let missingCode: OfficePreviewFailureCode = 'not_found'
  const cleanupMs = Math.min(10_000, Math.max(1, Math.floor(timeoutMs / 4)))

  try {
    const stat = await fs.stat(source)

    if (!stat.isFile()) {
      return { ok: false, code: 'not_found', cleanupSafe: true }
    }

    if (stat.size > OFFICE_SOURCE_MAX_BYTES) {
      return { ok: false, code: 'too_large', cleanupSafe: true }
    }

    missingCode = 'unavailable'
    const executable = await fs.realpath(program.executable)

    const candidates = officePowerShellCandidates(
      program.registryView,
      process.env.SystemRoot || 'C:\\Windows',
      process.arch
    )

    for (const candidate of candidates) {
      try {
        if ((await fs.stat(candidate)).isFile()) {
          powershell = candidate

          break
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }

    if (!powershell) {
      return { ok: false, code: 'unavailable', cleanupSafe: true }
    }

    const directory = await fs.mkdtemp(path.join(workDirectory, 'com-'))
    const pdfPath = path.join(directory, 'doc.pdf')
    env = {
      ...process.env,
      OFFICE_PROGID: program.progId,
      OFFICE_PROGRAM: executable,
      OFFICE_SOURCE: path.resolve(source),
      OFFICE_PDF: pdfPath,
      OFFICE_OWNER: path.join(directory, 'owner.json')
    }

    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(officeComScript(kind), 'utf16le').toString('base64')
    ]

    cleanupSafe = false
    missingCode = 'convert_failed'
    const result = await run(powershell, args, { cwd: directory, env, timeoutMs: Math.max(1, timeoutMs - cleanupMs) })
    const report = scriptResult(result.stdout)

    const cleanup = await run(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(OFFICE_COM_CLEANUP, 'utf16le').toString('base64')
      ],
      { cwd: directory, env, timeoutMs: cleanupMs }
    )

    cleanupSafe = !cleanup.failure && scriptResult(cleanup.stdout).ok === true

    if (!cleanupSafe) {
      return { ok: false, code: result.failure || 'convert_failed', cleanupSafe: false }
    }

    if (result.failure || report.ok !== true) {
      return {
        ok: false,
        code: result.failure || (report.code === 'unavailable' ? 'unavailable' : 'convert_failed'),
        cleanupSafe
      }
    }

    const pdf = await fs.lstat(pdfPath)

    if (!pdf.isFile() || pdf.isSymbolicLink() || !pdf.size) {
      return { ok: false, code: 'convert_failed', cleanupSafe }
    }

    if (pdf.size > OFFICE_PDF_MAX_BYTES) {
      return { ok: false, code: 'too_large', cleanupSafe }
    }

    const handle = await fs.open(pdfPath, 'r')
    const header = Buffer.alloc(5)

    try {
      await handle.read(header, 0, 5, 0)
    } finally {
      await handle.close()
    }

    return header.toString() === '%PDF-' ? { ok: true, pdfPath } : { ok: false, code: 'convert_failed', cleanupSafe }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    return { ok: false, code: code === 'ENOENT' ? missingCode : 'convert_failed', cleanupSafe }
  }
}
