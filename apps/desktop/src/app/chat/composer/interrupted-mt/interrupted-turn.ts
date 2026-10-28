import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect, useState } from 'react'

/** 与主进程一致：重新打开程序后 15 分钟内可以点 ▶ 继续。 */
export const RESUME_WINDOW_MS = 15 * 60 * 1000

/** 与 Hermes 原来自动续跑的说明同一开头；交付插件据此认出这是续跑，不再提醒“别接着做”。 */
export const CONTINUE_PREFIX = '[System note: Your previous turn was interrupted mid-run'

export interface InterruptedTurn {
  detectedAt: number
  prompt: string
  sessionId: string
}

/** 按会话编号存放可续跑的中断回答。 */
export const $interruptedTurns = atom<Record<string, InterruptedTurn>>({})

/** 向主进程要一次最新记录；浏览器版或测试里没有桌面桥时保持为空。 */
export async function refreshInterruptedTurns(): Promise<void> {
  const bridge = window.hermesDesktop?.interruptedTurns

  if (!bridge) {
    return
  }

  try {
    const turns = await bridge.list()

    $interruptedTurns.set(Object.fromEntries(turns.map(turn => [turn.sessionId, turn])))
  } catch {
    // 查询失败只是不显示 ▶，正常发送不受影响。
  }
}

/** 用户点了 ▶ 或这段对话开始了新的一轮，这条记录作废。 */
export function dismissInterruptedTurn(sessionId: string): void {
  const turns = { ...$interruptedTurns.get() }

  if (!(sessionId in turns)) {
    return
  }

  delete turns[sessionId]
  $interruptedTurns.set(turns)
  void window.hermesDesktop?.interruptedTurns?.dismiss(sessionId).catch(() => {})
}

/** 点 ▶ 时悄悄交给模型的说明，与 Hermes 原来自动续跑发送的文字相同。 */
export function continueNote(prompt: string): string {
  return (
    `${CONTINUE_PREFIX} — the app or its backend process stopped before the turn could finish. ` +
    'Some of the work may already be complete; check the current state before redoing anything, then ' +
    `finish the task. The interrupted request was:]\n\n${prompt}`
  )
}

/**
 * 当前会话可续跑的中断回答，没有就返回 null。
 * 连上后端或换会话时向主进程刷新；15 分钟一到自动消失；这段对话一开始新的一轮就作废。
 */
export function useInterruptedTurn(
  storedSessionId: null | string,
  connected: boolean,
  busy: boolean
): InterruptedTurn | null {
  const turns = useStore($interruptedTurns)
  const turn = storedSessionId ? (turns[storedSessionId] ?? null) : null
  const [now, setNow] = useState(() => Date.now())
  const expiresAt = turn ? turn.detectedAt + RESUME_WINDOW_MS : 0

  useEffect(() => {
    if (connected) {
      void refreshInterruptedTurns()
    }
  }, [connected, storedSessionId])

  useEffect(() => {
    setNow(Date.now())

    if (!expiresAt) {
      return
    }

    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()) + 50)

    return () => window.clearTimeout(timer)
  }, [expiresAt])

  useEffect(() => {
    if (busy && turn) {
      dismissInterruptedTurn(turn.sessionId)
    }
  }, [busy, turn])

  return turn && now < expiresAt ? turn : null
}
