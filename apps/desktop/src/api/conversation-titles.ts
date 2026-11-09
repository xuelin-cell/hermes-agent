import { hermesApi, type OwnerScope } from './client'

/** 提交确认后异步保存最小标题依据；调用方固定归属，失败不影响主回答或重复提交消息。 */
export async function seedConversationTitle(
  owner: OwnerScope,
  sessionId: string,
  temporary: string,
  intent: string
): Promise<void> {
  if (owner.connectionId && owner.connectionId !== 'local') {
    return
  }

  try {
    const profile = owner.profile || 'default'
    await hermesApi({
      connectionId: 'local',
      profile,
      path: `/api/plugins/uniwork-titles/seed?profile=${encodeURIComponent(profile)}`,
      method: 'POST',
      body: { sessionId, temporary, intent: intent.slice(0, 1800) },
      timeoutMs: 5000
    })
  } catch {
    /* 后端首轮观察器兜底；不弹标题错误，也不重发用户消息。 */
  }
}

import type { SessionInfo } from '@/types/hermes'

import { getSession } from './sessions'

const refreshing = new Map<string, { again: boolean; task: Promise<void> }>()

/** 同一归属的标题事件串行重读；临时/正式事件紧邻到达时，最后一轮读不会被早期观测压住。 */
export function refreshConversationTitle(
  owner: OwnerScope,
  id: string,
  apply: (row: SessionInfo) => void
): Promise<void> {
  const key = JSON.stringify([owner.connectionId || 'local', owner.profile || 'default', id])
  const existing = refreshing.get(key)

  if (existing) {
    existing.again = true

    return existing.task
  }

  const entry = { again: false, task: Promise.resolve() }
  entry.task = Promise.resolve().then(async () => {
    try {
      do {
        entry.again = false

        try {
          apply(await getSession(id, owner))
        } catch {
          /* 下次权威列表读取仍能恢复。 */
        }
      } while (entry.again)
    } finally {
      refreshing.delete(key)
    }
  })
  refreshing.set(key, entry)

  return entry.task
}
