// desktop-mt: 存档重读（切回会话、查看消息平台会话）会带回“有调用、没结果”的工具行，
// 所在消息不是进行中，原判断会把它画成“结果不可用”。这里判断它所属的这一轮是否还在跑。
import { useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'

import { useSessionView } from '@/app/chat/session-view'
import { isMessagingSource } from '@/lib/session-source'
import { $messagingSessions, sessionMatchesStoredId } from '@/store/session'

/** 消息平台会话桌面收不到“这一轮结束”的信号，最后一次存档更新超过这个时长就不再当作还在跑。 */
export const MESSAGING_TURN_STALE_SECONDS = 10 * 60

interface TurnMessage {
  content?: readonly unknown[]
  createdAt?: Date
  id: string
  role: string
}

/** 消息是否属于当前这一轮：它之后没有用户消息。 */
export function inCurrentTurn(messages: readonly TurnMessage[], messageId: string): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].id === messageId) {
      return messages[index].role === 'assistant'
    }

    if (messages[index].role === 'user') {
      return false
    }
  }

  return false
}

/** 当前这一轮（最后一条用户消息之后）最新的时间，单位秒；用来判断消息平台会话是否还有动静。 */
export function latestTurnActivitySeconds(messages: readonly TurnMessage[]): number {
  let latest = 0

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]

    if (message.role === 'user') {
      break
    }

    const created = message.createdAt?.getTime()

    if (created !== undefined && Number.isFinite(created)) {
      latest = Math.max(latest, created / 1000)
    }

    for (const part of message.content ?? []) {
      const stamps = part && typeof part === 'object' ? (part as { completedAt?: unknown; timestamp?: unknown }) : {}

      for (const value of [stamps.timestamp, stamps.completedAt]) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          latest = Math.max(latest, value)
        }
      }
    }
  }

  return latest
}

interface TurnFacts {
  /** 消息属于当前这一轮 */
  current: boolean
  /** 当前这一轮最新的时间（秒），0 表示不知道 */
  latest: number
  /** 正在看的是消息平台会话 */
  messaging: boolean
  /** 桌面会话处于忙碌 */
  running: boolean
}

/** 纯判断：当前这一轮里，桌面会话仍忙碌，或消息平台会话 10 分钟内仍有存档更新。 */
export function turnStillRunning(facts: TurnFacts, nowSeconds: number = Date.now() / 1000): boolean {
  if (!facts.current) {
    return false
  }

  if (facts.running) {
    return true
  }

  return facts.messaging && facts.latest > 0 && nowSeconds - facts.latest < MESSAGING_TURN_STALE_SECONDS
}

/** 当前查看的会话是不是消息平台会话（微信、钉钉等），这类会话的运行状态桌面拿不到。 */
function useViewingMessagingSession(): boolean {
  const storedId = useStore(useSessionView().$storedId)
  const sessions = useStore($messagingSessions)

  return Boolean(storedId) && isMessagingSource(sessions.find(s => sessionMatchesStoredId(s, storedId!))?.source)
}

/** 工具行用：没结果的工具所属这一轮是否还在跑；是则应显示“进行中”而不是“结果不可用”。 */
export function useToolTurnStillRunning(): boolean {
  const messaging = useViewingMessagingSession()

  // 读不到对话或消息（部分嵌入场景）时按“不在跑”处理，保持原来的显示。
  const current = useAuiState(state =>
    state.message?.id ? inCurrentTurn(state.thread?.messages ?? [], state.message.id) : false
  )

  const running = useAuiState(state => Boolean(state.thread?.isRunning))
  const latest = useAuiState(state => (messaging ? latestTurnActivitySeconds(state.thread?.messages ?? []) : 0))

  return turnStillRunning({ current, latest, messaging, running })
}
