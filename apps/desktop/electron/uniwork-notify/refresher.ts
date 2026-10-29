import { mergeMaasModelConfig } from '../entry_local/model-config'
import { writeAccountMaasKey } from '../entry_local/model-key'
import { updateUniaiToolkitConfig } from '../entry_local/uniai-toolkit-config'
import type { LoginSession } from '../login/session'

import type { NtfyRefreshResult } from './contract'

/**
 * `refresh_plan` / `refresh_model_config` 在主进程重拉套餐并落盘：
 * 模型目录、套餐专用 Key 与 UniAI 工具包都随套餐变化，页面拿不到这些凭据。
 * 并发指令合并成一次，串行无害（重拉类刷新天然幂等）。
 */
export function createPlanRefresher(
  session: () => LoginSession | null,
  home: () => string | null,
  log: (line: string) => void
): () => Promise<NtfyRefreshResult> {
  let running: Promise<NtfyRefreshResult> | null = null

  const run = async (): Promise<NtfyRefreshResult> => {
    const login = session()
    const identity = login?.currentIdentity() ?? null
    const directory = home()

    // 未登录或还没准备好账号目录：没有可落盘的位置，刷新不动任何文件。
    if (!login || !identity || !directory) {
      return { status: 'skipped' }
    }

    const queried = await login.queryPlan()

    if (login.currentIdentity()?.token !== identity.token) {
      return { status: 'skipped' }
    }

    const plan = login.currentPlan()

    try {
      if (queried.status === 'failed' || plan.status === 'failed') {
        log('ntfy 刷新套餐失败，保留原有账号配置')

        return { status: 'failed' }
      }

      if (plan.status === 'empty') {
        writeAccountMaasKey(directory, null)
        updateUniaiToolkitConfig(directory, 'empty')
        log('ntfy 刷新套餐：当前账号没有套餐，已清空专用 Key')

        return { status: 'ok' }
      }

      mergeMaasModelConfig(directory, plan.plan)
      writeAccountMaasKey(directory, plan.plan.apiKey)
      updateUniaiToolkitConfig(directory, 'available')
      log(`ntfy 刷新套餐：已更新 ${plan.plan.models.length} 个模型`)

      return { status: 'ok' }
    } catch (error) {
      log(`ntfy 刷新套餐写盘失败：${error instanceof Error ? error.message : '未知原因'}`)

      return { status: 'failed' }
    }
  }

  return () => {
    if (running) {
      return running
    }

    const task = run().finally(() => {
      if (running === task) {
        running = null
      }
    })

    running = task

    return task
  }
}
