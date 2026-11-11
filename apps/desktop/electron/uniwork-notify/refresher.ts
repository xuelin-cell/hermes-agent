import { mergeMaasModelConfig } from '../entry_local/model-config'
import { writeAccountMaasKey } from '../entry_local/model-key'
import { updateUniaiToolkitConfig } from '../entry_local/uniai-toolkit-config'
import type { LoginIdentity, LoginSession } from '../login/session'
import type { PlanUsage } from '../uniwork-usage/contract'

import type { NtfyRefreshResult } from './contract'

/**
 * 手动刷新与 ntfy 指令共用套餐查询和落盘流程：
 * 模型目录、套餐专用 Key 与 UniAI 工具包都随套餐变化，页面拿不到这些凭据。
 * 并发指令合并成一次，串行无害（重拉类刷新天然幂等）。
 */
export function createPlanRefresher(
  session: () => LoginSession | null,
  home: () => string | null,
  log: (line: string) => void,
  rememberUsage: (identity: LoginIdentity, data: PlanUsage) => void
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

    if (session() !== login || home() !== directory || login.currentIdentity()?.token !== identity.token) {
      return { status: 'skipped' }
    }

    const plan = login.currentPlan()

    try {
      if (queried.status === 'failed' || plan.status === 'failed') {
        log('刷新套餐失败，保留原有账号配置')

        return queried.status === 'failed' && queried.reason === 'auth'
          ? { status: 'failed', reason: 'auth' }
          : { status: 'failed' }
      }

      if (plan.status === 'empty') {
        mergeMaasModelConfig(directory, { models: [], mainModelIndex: 0 })
        writeAccountMaasKey(directory, null)
        updateUniaiToolkitConfig(directory, 'empty')
        log('刷新套餐：当前账号没有套餐，已清空专用 Key')
      } else {
        mergeMaasModelConfig(directory, plan.plan)
        writeAccountMaasKey(directory, plan.plan.apiKey)
        updateUniaiToolkitConfig(directory, 'available')
        log(`刷新套餐：已更新 ${plan.plan.models.length} 个模型`)
      }

      const usage = login.currentPlanUsage()

      if (usage) {
        rememberUsage(identity, usage)
      }

      return { status: 'ok' }
    } catch (error) {
      log(`刷新套餐写盘失败：${error instanceof Error ? error.message : '未知原因'}`)

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
