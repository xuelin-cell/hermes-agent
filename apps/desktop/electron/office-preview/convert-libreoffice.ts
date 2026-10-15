import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { OFFICE_TIMEOUT_MS } from '../../../shared/src/office-preview'

import type { ComConversionResult } from './convert-com'
import type { OfficeCliProgram } from './detect'
import { runOfficeProcess } from './run-process'

/** 独立配置只用于本次转换；超时或异常终止时保留现场，不碰用户 LibreOffice。 */
export async function convertLibreOffice(
  program: OfficeCliProgram,
  source: string,
  workDirectory: string,
  timeoutMs = OFFICE_TIMEOUT_MS,
  run = runOfficeProcess
): Promise<ComConversionResult> {
  const directory = await fs.mkdtemp(path.join(workDirectory, 'lo-'))
  const profile = path.join(directory, 'profile')
  let cleanupSafe = true

  try {
    // Windows 控制台入口会等待转换完成，不能借用提前返回的 GUI 启动器。
    const executable =
      process.platform === 'win32' ? path.join(path.dirname(program.executable), 'soffice.com') : program.executable

    if (!(await fs.stat(executable)).isFile()) {
      return { ok: false, code: 'unavailable', cleanupSafe }
    }

    await fs.mkdir(path.join(profile, 'user'), { recursive: true })
    await fs.writeFile(
      path.join(profile, 'user', 'registrymodifications.xcu'),
      '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>'
    )
    cleanupSafe = false

    const result = await run(
      executable,
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--headless',
        '--norestore',
        '--nologo',
        '--convert-to',
        'pdf',
        '--outdir',
        directory,
        source
      ],
      { cwd: directory, env: process.env, timeoutMs }
    )

    // 失败时辅助进程可能已有后代；没有准确归属就不强杀，也不删除仍可能在用的配置。
    cleanupSafe = !result.failure || result.failure === 'unavailable'

    return result.failure
      ? { ok: false, code: result.failure, cleanupSafe }
      : { ok: true, pdfPath: path.join(directory, path.basename(source, path.extname(source)) + '.pdf') }
  } catch (error) {
    return {
      ok: false,
      code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'convert_failed',
      cleanupSafe
    }
  } finally {
    if (cleanupSafe) {
      await fs.rm(profile, { recursive: true, force: true })
    }
  }
}
