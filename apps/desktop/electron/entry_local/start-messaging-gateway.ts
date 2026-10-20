import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { accountDesktopEnvironment, accountSourceBackend } from './desktop-environment'
import type { PreparedLocalContext } from './runtime-context'

// libuv's detached Windows spawn has no console: descendants may allocate visible ones.
// A short, hidden Python launcher uses Hermes's native hidden-console detach flags instead.
const WINDOWS_LAUNCH = `import subprocess, sys
from hermes_cli._subprocess_compat import windows_detach_flags, windows_detach_flags_without_breakaway
def launch(flags):
    return subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=sys.stdout,
                            stderr=sys.stderr, close_fds=True, creationflags=flags)
try:
    launch(windows_detach_flags())
except PermissionError:
    launch(windows_detach_flags_without_breakaway())
`

export function messagingGatewayLaunch(command: string, args: string[], isWindows = process.platform === 'win32') {
  return {
    command,
    args: isWindows ? ['-c', WINDOWS_LAUNCH, command, ...args] : args,
    detached: !isWindows
  }
}

/**
 * 启动账号自己的前台 CLI，并交由原生网关 PID 锁决定是否已运行。
 * 不安装系统服务，不接管现有进程；完整退出由账号原有网关清理事务停止。
 */
export async function startAccountMessagingGateway(context: PreparedLocalContext): Promise<void> {
  const env = accountDesktopEnvironment(context)
  const backend = accountSourceBackend(context, ['gateway', 'run'], env)
  const launch = messagingGatewayLaunch(backend.command, backend.args)
  const logs = path.join(context.home, 'logs')
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 })
  const log = fs.openSync(path.join(logs, 'desktop-gateway-launch.log'), 'a', 0o600)

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, {
        cwd: context.workspace,
        env: { ...env, ...backend.env, HERMES_GATEWAY_DETACHED: '1' },
        detached: launch.detached,
        windowsHide: true,
        stdio: ['ignore', log, log]
      })

      child.once('error', () => reject(new Error('当前账号消息网关无法启动。')))
      child.once('spawn', () => {
        child.unref()

        if (launch.detached) {
          resolve()
        }
      })

      // Windows waits for the launcher to confirm Popen succeeded, not just its own spawn.
      if (!launch.detached) {
        child.once('close', code => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error('当前账号消息网关无法启动。'))
          }
        })
      }
    })
  } finally {
    fs.closeSync(log)
  }
}
