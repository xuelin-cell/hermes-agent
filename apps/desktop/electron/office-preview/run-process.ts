import { execFile } from 'node:child_process'

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
}

/** 隐藏运行有界辅助进程，等退出后返回；Office 服务进程另按归属记录收尾。 */
export function runOfficeProcess(
  executable: string,
  args: string[],
  options: OfficeProcessOptions
): Promise<OfficeProcessResult> {
  return new Promise(resolve => {
    const child = execFile(
      executable,
      args,
      hiddenWindowsChildOptions({
        ...options,
        encoding: 'utf8',
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024
      }),
      (error, stdout) => {
        const code = error?.code

        const failure = !error
          ? undefined
          : code === 'ENOENT' || code === 'EACCES'
            ? 'unavailable'
            : code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              ? 'convert_failed'
              : error.killed
                ? 'timeout'
                : 'convert_failed'

        resolve({ stdout, failure })
      }
    )

    child.stdin?.end()
  })
}
