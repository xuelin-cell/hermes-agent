import { execFile } from 'node:child_process'
import path from 'node:path'

import { accountDesktopEnvironment, accountSourceBackend } from './desktop-environment'
import type { LogoutProcess } from './logout-processes'
import type { PreparedLocalContext } from './runtime-context'

export interface AccountGateway {
  pid: number
  created: number
  home: string
  launcher: boolean
  external: boolean
}

/** 只用已固定的源码解释器运行一次性原版适配，不向页面暴露网关控制能力。 */
export function accountGatewayLogout(
  context: PreparedLocalContext,
  operation: 'snapshot' | 'stop' | 'check',
  saved: AccountGateway[] = []
): Promise<AccountGateway[]> {
  const env = accountDesktopEnvironment(context)
  const backend = accountSourceBackend(context, [], env)
  const script = path.join(context.installationRoot, 'apps/desktop/electron/entry_local/gateway-logout.py')

  return new Promise((resolve, reject) => {
    const child = execFile(
      backend.command,
      [script, operation],
      {
        cwd: context.installationRoot,
        env: { ...env, ...backend.env },
        windowsHide: true,
        timeout: 90_000,
        maxBuffer: 1024 * 1024
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('无法完成当前账号消息网关停止验证，请重试。'))

          return
        }

        try {
          const rows: AccountGateway[] = JSON.parse(stdout)

          if (
            !Array.isArray(rows) ||
            rows.some(
              row =>
                !Number.isSafeInteger(row.pid) ||
                row.pid <= 0 ||
                !Number.isFinite(row.created) ||
                row.created <= 0 ||
                typeof row.home !== 'string' ||
                typeof row.launcher !== 'boolean' ||
                typeof row.external !== 'boolean'
            )
          ) {
            throw new Error()
          }

          resolve(rows)
        } catch {
          reject(new Error('账号网关归属检查失败。'))
        }
      }
    )

    child.stdin?.end(JSON.stringify(saved))
  })
}

/** 将网关指纹与原生进程表交叉验证，再纳入同一持久退出子树。 */
export function gatewayLogoutRoots(gateways: AccountGateway[], processes: LogoutProcess[]): number[] {
  return gateways.flatMap(gateway => {
    const row = processes.find(process => process.pid === gateway.pid)

    if (!row) {return []}

    if (!row.started) {throw new Error('无法核对消息网关创建时间。')}
    const created = Number(BigInt(row.started) - 621355968000000000n) / 10_000_000

    return Math.abs(created - gateway.created) < 0.001 ? [gateway.pid] : []
  })
}
