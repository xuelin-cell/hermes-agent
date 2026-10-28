import { type ThreadMessage } from '@assistant-ui/react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { $messagingSessions, $selectedStoredSessionId } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime, userMessage } from '../test-utils'
import { Thread } from '../thread'
import { MESSAGING_TURN_STALE_SECONDS, turnStillRunning } from '../tool/turn-still-running'

// desktop-mt: 存档重读（切回会话、查看消息平台会话）带回的“有调用、没结果”工具行，
// 所在消息不是进行中；这一轮还在跑时应显示进行中，不能显示“结果不可用”。

stubThreadEnvironment()
stubThreadViewportSize()

/** 一条从存档读回来的回复：消息已是完成状态，工具有调用、没结果。 */
function storedAssistant(createdAt: Date, extra: Record<string, unknown> = {}): ThreadMessage {
  const args = { command: 'ls' }

  return {
    id: 'assistant-stored',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'terminal',
        args,
        argsText: JSON.stringify(args),
        timestamp: createdAt.getTime() / 1000,
        ...extra
      }
    ],
    status: { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
  } as unknown as ThreadMessage
}

/** 渲染对话并等它画出工具行。 */
async function renderThread(messages: ThreadMessage[], isRunning: boolean) {
  const view = render(
    <ThreadRuntime isRunning={isRunning} messages={messages}>
      <Thread />
    </ThreadRuntime>
  )

  await waitFor(() => expect(view.container.querySelector('[data-tool-row]')).not.toBeNull())

  return view
}

/** 中英文界面下的“结果不可用”。 */
const UNAVAILABLE = /Result unavailable|结果不可用/

const now = () => new Date()
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

afterEach(() => {
  cleanup()
  $messagingSessions.set([])
  $selectedStoredSessionId.set(null)
})

describe('没结果的工具：这一轮还在跑时显示进行中', () => {
  it('桌面会话忙碌、工具在当前这一轮：不显示结果不可用', async () => {
    await renderThread([userMessage(), storedAssistant(now())], true)

    expect(screen.queryByText(UNAVAILABLE)).toBeNull()
  })

  it('桌面会话已空闲：仍显示结果不可用', async () => {
    await renderThread([userMessage(), storedAssistant(now())], false)

    expect(screen.getByText(UNAVAILABLE)).toBeTruthy()
  })

  it('工具在更早的一轮（后面已有新的用户消息）：仍显示结果不可用', async () => {
    await renderThread([userMessage('user-1'), storedAssistant(now()), userMessage('user-2', 'next')], true)

    expect(screen.getByText(UNAVAILABLE)).toBeTruthy()
  })

  it('已被标记结束（停止、丢失结果）：会话忙碌也仍显示结果不可用', async () => {
    const createdAt = now()
    await renderThread([userMessage(), storedAssistant(createdAt, { completedAt: createdAt.getTime() / 1000 })], true)

    expect(screen.getByText(UNAVAILABLE)).toBeTruthy()
  })

  it('消息平台会话、10 分钟内有存档更新：不显示结果不可用', async () => {
    $messagingSessions.set([{ id: 'stored-weixin', source: 'weixin' } as SessionInfo])
    $selectedStoredSessionId.set('stored-weixin')
    await renderThread([userMessage(), storedAssistant(minutesAgo(1))], false)

    expect(screen.queryByText(UNAVAILABLE)).toBeNull()
  })

  it('消息平台会话、超过 10 分钟没有存档更新：显示结果不可用', async () => {
    $messagingSessions.set([{ id: 'stored-weixin', source: 'weixin' } as SessionInfo])
    $selectedStoredSessionId.set('stored-weixin')
    await renderThread([userMessage(), storedAssistant(minutesAgo(11))], false)

    expect(screen.getByText(UNAVAILABLE)).toBeTruthy()
  })

  it('不是消息平台会话、空闲：不按时间放宽', async () => {
    await renderThread([userMessage(), storedAssistant(minutesAgo(1))], false)

    expect(screen.getByText(UNAVAILABLE)).toBeTruthy()
  })
})

describe('turnStillRunning', () => {
  const base = { current: true, latest: 1000, messaging: false, running: false }

  it('不在当前这一轮时一律不算在跑', () => {
    expect(turnStillRunning({ ...base, current: false, running: true }, 1000)).toBe(false)
  })

  it('消息平台会话按最后一次更新时间判断，边界不含', () => {
    const messaging = { ...base, messaging: true }

    expect(turnStillRunning(messaging, 1000 + MESSAGING_TURN_STALE_SECONDS - 1)).toBe(true)
    expect(turnStillRunning(messaging, 1000 + MESSAGING_TURN_STALE_SECONDS)).toBe(false)
    expect(turnStillRunning({ ...messaging, latest: 0 }, 1000)).toBe(false)
  })
})
