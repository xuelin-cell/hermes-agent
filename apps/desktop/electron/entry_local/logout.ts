import fs from 'node:fs'
import path from 'node:path'

import { writeSecretFileAtomic } from '../hardening'
import { CredentialStore } from '../login/credential-store'

import type { LogoutProcess } from './logout-processes'

/** 固定应用级退出标记；存在时禁止恢复登录或开始另一个账号。 */
export function logoutIntentPath(userData: string): string {
  return path.join(userData, 'maas-logout-pending.json')
}

/** 退出事务只合并正在执行的请求；失败保留标记和归属，下一次显式重试。 */
export function createAccountLogout(deps: {
  userData: string
  account: string
  seal: () => void
  snapshot: () => LogoutProcess[]
  stop: (processes: LogoutProcess[]) => Promise<void>
  release: () => void
  relaunch: () => Promise<void>
}) {
  let pending: Promise<void> | null = null
  let started = false
  let owned: LogoutProcess[] | null = null

  /** 先写失效意图，再封闭运行时；只有停止验证成功才删除登录记录。 */
  async function run(): Promise<void> {
    const marker = logoutIntentPath(deps.userData)

    if (!started) {
      writeSecretFileAtomic(marker, JSON.stringify({ account: deps.account }))
      started = true
      deps.seal()
    }

    owned ??= deps.snapshot()
    writeSecretFileAtomic(marker, JSON.stringify({ account: deps.account, processes: owned }))
    await deps.stop(owned)
    deps.release()
    new CredentialStore(deps.userData).clear()
    // 此后即使重启失败，也不再存在可恢复的旧登录。
    fs.unlinkSync(marker)
    await deps.relaunch()
  }

  return {
    started: (): boolean => started,
    /** 同时发生的多窗口退出只执行一次，失败后允许重试停止。 */
    run(): Promise<void> {
      pending ??= run().finally(() => {
        pending = null
      })

      return pending
    }
  }
}
