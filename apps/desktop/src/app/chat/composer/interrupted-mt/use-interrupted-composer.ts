import { useStore } from '@nanostores/react'
import { useCallback, useRef } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { triggerHaptic } from '@/lib/haptics'

import type { ChatBarProps } from '../types'

import { useInterruptedCopy } from './copy'
import { continueNote, dismissInterruptedTurn, useInterruptedTurn } from './interrupted-turn'

/**
 * 输入框接入中断续跑：有可续跑的回答时给出提示文字和 ▶ 的点击处理，没有就都为空。
 * 点 ▶ 以隐藏消息发出续跑说明，聊天里不出现用户气泡。
 */
export function useInterruptedComposer({
  busy,
  connected,
  onSubmit
}: {
  busy: boolean
  connected: boolean
  onSubmit: ChatBarProps['onSubmit']
}): { onContinue?: () => void; placeholder?: string } {
  const view = useSessionView()
  const storedSessionId = useStore(view.$storedId)
  const turn = useInterruptedTurn(storedSessionId, connected, busy)
  const copy = useInterruptedCopy()
  const sending = useRef(false)

  const onContinue = useCallback(async () => {
    if (!turn || sending.current) {
      return
    }

    sending.current = true
    triggerHaptic('submit')

    try {
      if (await onSubmit(continueNote(turn.prompt), { displayKind: 'hidden' })) {
        dismissInterruptedTurn(turn.sessionId)
      }
    } finally {
      sending.current = false
    }
  }, [onSubmit, turn])

  return turn ? { onContinue: () => void onContinue(), placeholder: copy('placeholder') } : {}
}
