import { execFile } from 'node:child_process'
import path from 'node:path'

import type { OfficePreviewFailureCode } from '../../../shared/src/office-preview'
import { hiddenWindowsChildOptions } from '../windows-child-options'

export interface OfficeProcessOptions {
  env: NodeJS.ProcessEnv
  cwd: string
  timeoutMs: number
}

export interface OfficeProcessResult {
  stdout: string
  failure?: OfficePreviewFailureCode
  /** 超时后是否确认结束了整个进程树；为 false 时可能仍有后代进程在运行。 */
  stopped?: boolean
}

/** 结束辅助进程及其全部后代；返回是否确认成功，失败时调用方不能当作已收尾。 */
function stopProcessTree(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') {
    try {
      // 非 Windows 平台以独立进程组启动，负 PID 表示整组。
      process.kill(-pid, 'SIGKILL')

      return Promise.resolve(true)
    } catch {
      return Promise.resolve(false)
    }
  }

  const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')

  return new Promise(resolve => {
    execFile(taskkill, ['/PID', String(pid), '/T', '/F'], hiddenWindowsChildOptions({ timeout: 10_000 }), error =>
      resolve(!error)
    )
  })
}

/** 隐藏运行有界辅助进程，等退出后返回；超时结束整棵进程树，LibreOffice 启动器的子进程不会随启动器退出。 */
export function runOfficeProcess(
  executable: string,
  args: string[],
  options: OfficeProcessOptions
): Promise<OfficeProcessResult> {
  return new Promise(resolve => {
    let stopping: Promise<boolean> | undefined

    const child = execFile(
      executable,
      args,
      hiddenWindowsChildOptions({
        cwd: options.cwd,
        env: options.env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        detached: process.platform !== 'win32'
      }),
      (error, stdout) => {
        clearTimeout(timer)

        if (stopping) {
          void stopping.then(stopped => resolve({ stdout, failure: 'timeout', stopped }))

          return
        }

        const code = error?.code

        const failure = !error ? undefined : code === 'ENOENT' || code === 'EACCES' ? 'unavailable' : 'convert_failed'

        resolve({ stdout, failure })
      }
    )

    const timer = setTimeout(() => {
      stopping = child.pid ? stopProcessTree(child.pid) : Promise.resolve(false)
      // 先按进程树结束；树查询失败时至少结束直接子进程，让本次调用能够返回。
      void stopping.then(() => child.kill('SIGKILL'))
    }, options.timeoutMs)

    child.stdin?.end()
  })
}
