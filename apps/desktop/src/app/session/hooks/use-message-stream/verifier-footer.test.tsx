import type { GatewayEvent } from '@hermes/shared'
import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { reconcileActiveTranscript } from '@/app/contrib/hooks/use-background-sync'
import { getLatestSessionMessages } from '@/hermes'
import { chatMessageText, toChatMessages } from '@/lib/chat-messages'
import { resetLiveSync } from '@/store/live-sync'
import {
  setActiveSessionId,
  setAwaitingResponse,
  setBusy,
  setMessages,
  setSelectedStoredSessionId
} from '@/store/session'
import { $sessionStates, clearAllSessionStates } from '@/store/session-states'
import { clearSessionTodos } from '@/store/todos'
import type { SessionMessage } from '@/types/hermes'

import { useSessionStateCache } from '../use-session-state-cache'

import { useMessageStream } from './index'

vi.mock('@/hermes', async original => ({
  ...(await original<Record<string, unknown>>()),
  getLatestSessionMessages: vi.fn()
}))

const RUNTIME = 'verifier-runtime'
const STORED = 'verifier-stored'
const FIX = '封面装饰越界，修复这两处。'
const FINAL = 'PPT 已生成成功。\n\nMEDIA:C:\\ws\\output.pptx'

const FOOTER =
  '⚠️ File-mutation verifier: 1 file edit(s) FAILED this turn despite any wording above that may suggest otherwise. Run `git status` or `read_file` to confirm what actually landed.\n' +
  '  • `C:\\ws\\slides_4.js` — [patch] Could not find a match for old_string in the file'

const tools = ['patch-1', 'patch-2']
const noop = async () => undefined

const history: SessionMessage[] = [{ id: 1, role: 'user', content: '做成一个ppt交给我', timestamp: 1 }]

// 数据库里的记录不含核对提醒：后端在存档之后才追加它。
const durableTurn: SessionMessage[] = [
  ...history,
  {
    id: 2,
    role: 'assistant',
    content: FIX,
    timestamp: 2,
    tool_calls: tools.map(id => ({ id, type: 'function', function: { name: 'patch', arguments: '{}' } }))
  },
  { id: 3, role: 'tool', content: '{"success": true}', timestamp: 3, tool_call_id: tools[0], tool_name: 'patch' },
  { id: 4, role: 'tool', content: '{"success": false}', timestamp: 4, tool_call_id: tools[1], tool_name: 'patch' },
  { id: 5, role: 'assistant', content: FINAL, timestamp: 5 }
]

let cache: ReturnType<typeof useSessionStateCache>
let stream: ReturnType<typeof useMessageStream>
let refresh: () => Promise<void>

/** 挂载真实的会话缓存、消息流处理和后台刷新，只替换数据库读取。 */
function Harness() {
  const busyRef = useRef(false)
  const queryClient = useRef(new QueryClient()).current
  const requestSequenceRef = useRef(0)
  const signatureRef = useRef(new Map<string, string>())
  cache = useSessionStateCache({
    activeSessionId: RUNTIME,
    selectedStoredSessionId: STORED,
    busyRef,
    setBusy,
    setAwaitingResponse,
    setMessages
  })
  stream = useMessageStream({
    ...cache,
    queryClient,
    hydrateFromStoredSession: noop,
    refreshHermesConfig: noop,
    refreshSessions: noop
  })
  refresh = () =>
    reconcileActiveTranscript({
      activeSessionIdRef: cache.activeSessionIdRef,
      selectedStoredSessionIdRef: cache.selectedStoredSessionIdRef,
      updateSessionState: cache.updateSessionState,
      busyRef,
      requestSequenceRef,
      signatureRef,
      resolveSession: () => ({ profile: 'default' })
    })

  return null
}

/** 以当前会话身份送入一条网关事件。 */
function send(type: GatewayEvent['type'], payload: GatewayEvent['payload'] = {}) {
  act(() => stream.handleGatewayEvent({ session_id: RUNTIME, type, payload }))
}

/** 当前会话界面上每个气泡的文字。 */
const texts = () => $sessionStates.get()[RUNTIME].messages.map(chatMessageText)

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(getLatestSessionMessages).mockReset()
  setActiveSessionId(RUNTIME)
  setSelectedStoredSessionId(STORED)
})

afterEach(() => {
  cleanup()
  clearSessionTodos(RUNTIME)
  clearAllSessionStates()
  resetLiveSync()
  setActiveSessionId(null)
  setSelectedStoredSessionId(null)
  setBusy(false)
  setAwaitingResponse(false)
  setMessages([])
  localStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('drops the live-only verifier footer and keeps one final answer after the durable refresh', async () => {
  render(<Harness />)
  act(() => cache.updateSessionState(RUNTIME, state => ({ ...state, messages: toChatMessages(history) }), STORED))

  send('message.start')
  send('message.delta', { text: FIX })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  send('message.interim', { text: FIX, already_streamed: true })

  for (const id of tools) {
    send('tool.start', { name: 'patch', tool_id: id, args: {} })
    send('tool.complete', { name: 'patch', tool_id: id, result: 'ok' })
  }

  send('message.delta', { text: FINAL })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  send('message.complete', {
    text: `${FINAL}\n\n${FOOTER}`,
    persisted_turn: { row_ids: [1, 2, 3, 4, 5], user_row_id: 1, final_assistant_row_id: 5, complete: true }
  })

  const live = texts()

  expect(live.some(text => text.includes('File-mutation verifier'))).toBe(false)
  expect(live.filter(text => text.includes('PPT 已生成成功'))).toHaveLength(1)

  vi.mocked(getLatestSessionMessages).mockResolvedValue({ session_id: STORED, messages: durableTurn })
  await act(async () => {
    await refresh()
  })

  const refreshed = texts()

  expect(refreshed.some(text => text.includes('File-mutation verifier'))).toBe(false)
  expect(refreshed.filter(text => text.includes('PPT 已生成成功'))).toHaveLength(1)
})
