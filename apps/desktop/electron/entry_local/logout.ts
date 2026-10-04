import fs from 'node:fs'
import path from 'node:path'

import { writeSecretFileAtomic } from '../hardening'
import { CredentialStore } from '../login/credential-store'

import type { LogoutProcess } from './logout-processes'

export type AccountExitMode = 'logout' | 'quit'

/** 固定应用级运行记录；上次未完成收尾时，必须先清理再放行登录。 */
export function logoutIntentPath(userData: string): string {
  return path.join(userData, 'maas-logout-pending.json')
}

/** 正常运行默认保留登录；开始托管工作前落盘，覆盖尚未点击退出就崩溃的情况。 */
export function recordAccountRun(userData: string, account: string): void {
  writeSecretFileAtomic(logoutIntentPath(userData), JSON.stringify({ account, mode: 'quit' }))
}

/** 停止与归属释放均成功后才完成原退出意图；普通退出保留原登录期限。 */
export function completeAccountExit(userData: string, mode: AccountExitMode): void {
  if (mode === 'logout') {
    new CredentialStore(userData).clear()
  }

  fs.unlinkSync(logoutIntentPath(userData))
}

/** 退出事务只合并正在执行的请求；失败保留标记和归属，下一次显式重试。 */
export function createAccountLogout(deps: {
  userData: string
  account: string
  seal: () => void
  snapshot: () => LogoutProcess[] | Promise<LogoutProcess[]>
  stop: (processes: LogoutProcess[]) => Promise<void>
  release: () => void
  finish: (mode: AccountExitMode) => Promise<void>
}) {
  let pending: Promise<void> | null = null
  let started = false
  let owned: LogoutProcess[] | null = null
  let mode: AccountExitMode | null = null
  let sealed = false

  /** 先写失效意图，再封闭运行时；只有停止验证成功才删除登录记录。 */
  async function run(requested: AccountExitMode): Promise<void> {
    const marker = logoutIntentPath(deps.userData)

    if (!started) {
      writeSecretFileAtomic(marker, JSON.stringify({ account: deps.account, mode: requested }))
      mode = requested
      started = true
    }

    if (!sealed) {
      deps.seal()
      sealed = true
    }

    owned ??= await deps.snapshot()
    writeSecretFileAtomic(marker, JSON.stringify({ account: deps.account, mode, processes: owned }))
    await deps.stop(owned)
    deps.release()

    completeAccountExit(deps.userData, mode!)
    await deps.finish(mode!)
  }

  return {
    started: (): boolean => started,
    /** 同时发生的多窗口退出只执行一次，失败后允许重试停止。 */
    run(requested: AccountExitMode = 'logout'): Promise<void> {
      pending ??= run(requested).finally(() => {
        pending = null
      })

      return pending
    }
  }
}
