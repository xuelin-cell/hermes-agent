import fs from 'node:fs/promises'
import path from 'node:path'

import {
  OFFICE_TIMEOUT_MS,
  officeDocumentKind,
  type OfficePreviewFailureCode
} from '../../../shared/src/office-preview'

import { officeComCleanupScript, officeComScript } from './com-scripts'
import type { OfficeComProgram, OfficeRegistryView } from './detect'
import { WPS_EXECUTABLES } from './detect'
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

// 加密后的 docx／pptx／xlsx 不再是 zip，而是以这 8 个字节开头的 OLE 复合文件。
const OLE_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex')

/** 选择与 COM 注册位数相同的系统 PowerShell，避免 32 位 WPS 被送到 64 位入口。 */
export function officePowerShellCandidates(view: OfficeRegistryView, systemRoot: string, arch: string): string[] {
  const directories =
    view === '32' ? ['SysWOW64', 'System32'] : arch === 'ia32' ? ['Sysnative', 'System32'] : ['System32']

  return directories.map(directory =>
    path.win32.join(systemRoot, directory, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  )
}

/** 脚本按这些程序名统计启动前后的进程；WPS 的同一入口可能由安装目录里的另一个组件承担。 */
export function officeComEnvironment(program: OfficeComProgram): NodeJS.ProcessEnv {
  const executables = [
    path.win32.basename(program.executable),
    ...(program.provider === 'wps' ? WPS_EXECUTABLES[program.kind] : [])
  ]

  return {
    OFFICE_PROGID: program.progId,
    OFFICE_NAMES: JSON.stringify([...new Set(executables.map(name => name.replace(/\.exe$/i, '').toLowerCase()))])
  }
}

/** 只读取辅助脚本最后一行结果；不将异常文本或内部路径交给前端。 */
function scriptResult(stdout: string): { ok?: boolean; code?: OfficePreviewFailureCode; clean?: boolean } {
  try {
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || '')

    return result && typeof result === 'object' ? result : {}
  } catch {
    return {}
  }
}

/** 把脚本编码为 PowerShell 的启动参数，路径等数据只走环境变量。 */
function encodedArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

/** 用匹配位数的 PowerShell 执行转换脚本；脚本没确认收尾（超时、崩溃）时才再执行一次收尾脚本。 */
export async function runComScript(
  program: OfficeComProgram,
  script: string,
  env: NodeJS.ProcessEnv,
  directory: string,
  timeoutMs: number,
  run: typeof runOfficeProcess = runOfficeProcess
): Promise<{ ok: boolean; code: OfficePreviewFailureCode; cleanupSafe: boolean }> {
  let powershell: string | undefined

  for (const candidate of officePowerShellCandidates(
    program.registryView,
    process.env.SystemRoot || 'C:\\Windows',
    process.arch
  )) {
    if (
      await fs.stat(candidate).then(
        stat => stat.isFile(),
        () => false
      )
    ) {
      powershell = candidate

      break
    }
  }

  if (!powershell) {
    return { ok: false, code: 'unavailable', cleanupSafe: true }
  }

  const owner = path.join(directory, 'owner.json')

  const options = {
    cwd: directory,
    env: { ...process.env, ...officeComEnvironment(program), ...env, OFFICE_OWNER: owner }
  }

  const cleanupMs = Math.min(10_000, Math.max(1, Math.floor(timeoutMs / 4)))

  const result = await run(powershell, encodedArgs(script), {
    ...options,
    timeoutMs: Math.max(1, timeoutMs - cleanupMs)
  })

  const report = scriptResult(result.stdout)
  const code = result.failure || (report.code === 'unavailable' ? 'unavailable' : 'convert_failed')
  let cleanupSafe = report.clean === true

  if (!cleanupSafe) {
    // 没有留下记录，说明脚本没跑到启动 Office 那一步（例如被策略拦截），没有需要收尾的东西。
    const started = await fs.stat(owner).then(
      () => true,
      () => false
    )

    const cleanup = started
      ? await run(powershell, encodedArgs(officeComCleanupScript(program.kind)), { ...options, timeoutMs: cleanupMs })
      : null

    cleanupSafe = !cleanup || (!cleanup.failure && scriptResult(cleanup.stdout).ok === true)
  }

  return { ok: !result.failure && report.ok === true, code, cleanupSafe }
}

/** 加密的 Office 文件用 Office 打开会弹密码框、卡到超时，转换前按文件头识别。 */
async function isEncryptedPackage(source: string): Promise<boolean> {
  if (!/\.(docx|pptx|xlsx)$/i.test(source)) {
    return false
  }

  const handle = await fs.open(source, 'r')

  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(8), 0, 8, 0)

    return bytesRead === 8 && buffer.equals(OLE_SIGNATURE)
  } finally {
    await handle.close()
  }
}

/** 将探测到的 COM 程序用于实际转换；PDF 的大小和格式由转换服务统一检查。 */
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

  try {
    if (await isEncryptedPackage(source)) {
      return { ok: false, code: 'convert_failed', cleanupSafe: true }
    }
  } catch {
    return { ok: false, code: 'not_found', cleanupSafe: true }
  }

  try {
    const directory = await fs.mkdtemp(path.join(workDirectory, 'com-'))
    const pdfPath = path.join(directory, 'doc.pdf')
    const env = { OFFICE_SOURCE: path.resolve(source), OFFICE_PDF: pdfPath }
    const result = await runComScript(program, officeComScript(kind), env, directory, timeoutMs, run)

    // 已导出 PDF 时即使实例没能确认退出也返回结果，残留进程已由收尾脚本处理。
    return result.ok ? { ok: true, pdfPath } : { ok: false, code: result.code, cleanupSafe: result.cleanupSafe }
  } catch {
    // 只有工作目录创建失败会走到这里，此时还没有启动任何程序。
    return { ok: false, code: 'convert_failed', cleanupSafe: true }
  }
}
