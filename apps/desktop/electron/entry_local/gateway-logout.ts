import { spawn } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline'

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

export interface AccountExitSnapshot {
  processes: LogoutProcess[]
  gateways: AccountGateway[]
}

/** 验证辅助进程的纯归属数据，拒绝坏指纹及额外命令行或凭据字段。 */
function validSnapshot(value: AccountExitSnapshot): boolean {
  return Boolean(
    value && Object.keys(value).length === 2 && Array.isArray(value.processes) && Array.isArray(value.gateways) &&
    value.processes.every(row => row && Object.keys(row).length === 3 &&
      Number.isSafeInteger(row.pid) && row.pid >= 0 && Number.isSafeInteger(row.parent) && row.parent >= 0 &&
      typeof row.started === 'string' && /^\d*$/.test(row.started)) &&
    value.gateways.every(row => row && Object.keys(row).length === 5 &&
      Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isFinite(row.created) && row.created > 0 &&
      typeof row.home === 'string' && typeof row.launcher === 'boolean' && typeof row.external === 'boolean')
  )
}

/** 仅在本次退出期间共用一个原版适配进程，操作失败或收尾结束即释放。 */
export function createAccountGatewayLogout(context: PreparedLocalContext) {
  const env = accountDesktopEnvironment(context)
  const backend = accountSourceBackend(context, [], env)

  const child = spawn(backend.command, [path.join(context.installationRoot, 'apps/desktop/electron/entry_local/gateway-logout.py')], {
    cwd: context.installationRoot, env: { ...env, ...backend.env }, windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  })

  const output = createInterface({ input: child.stdout })
  let closed = false
  let disposal: Promise<void> | null = null

  let pending: {
    resolve: (snapshot: AccountExitSnapshot) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  /** 只撤销本次辅助进程；失败不释放账号归属，也不暴露原始错误。 */
  function dispose(): Promise<void> {
    if (disposal) {return disposal}

    closed = true
    clearTimeout(pending?.timer)
    pending?.reject(new Error('无法完成当前账号消息网关停止验证，请重试。'))
    pending = null
    disposal = new Promise(resolve => {
      // 为脚本两段各三秒的查询清理留出时间，异常时再终止自己的句柄。
      const timer = setTimeout(() => child.kill(), 7_000)
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      output.close()
      child.stdin.end()
    })

    return disposal
  }

  child.on('error', () => void dispose())
  child.on('exit', () => void dispose())
  child.stdin.on('error', () => void dispose())
  output.on('line', line => {
    try {
      const response: AccountExitSnapshot = JSON.parse(line)

      if (!pending || line.length > 1024 * 1024 || !validSnapshot(response)) {
        void dispose()

        return
      }

      const request = pending
      pending = null
      clearTimeout(request.timer)
      request.resolve(response)
    } catch {
      void dispose()
    }
  })

  return {
    dispose,
    /** 串行请求真实快照、计划停止和新鲜终检；超时或通道断开均不放行。 */
    run(operation: 'snapshot' | 'stop' | 'check', saved: AccountGateway[] = []): Promise<AccountExitSnapshot> {
      if (closed || pending) {
        return Promise.reject(new Error('无法完成当前账号消息网关停止验证，请重试。'))
      }

      return new Promise((resolve, reject) => {
        pending = { resolve, reject, timer: setTimeout(dispose, 90_000) }
        child.stdin.write(JSON.stringify({ operation, saved }) + '\n')
      })
    }
  }
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
