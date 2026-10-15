import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { OFFICE_TIMEOUT_MS } from '../../../shared/src/office-preview'

import type { ComConversionResult } from './convert-com'
import type { OfficeCliProgram } from './detect'
import { runOfficeProcess } from './run-process'

/** 独立配置只用于本次转换；超时时结束本次的整个进程树，无法确认结束才保留现场，不碰用户 LibreOffice。 */
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

    // 本次进程树是由我们启动的；只有超时且没能确认结束整棵树时，才可能还有进程在用配置。
    cleanupSafe = result.stopped !== false

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
