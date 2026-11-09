import { useAuiState } from '@assistant-ui/react'
import type { GatewayEvent } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useCallback, useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ChatRuntimeBoundary } from '@/app/chat'
import { PRIMARY_SESSION_VIEW } from '@/app/chat/session-view'
import { mergeOlderTranscriptPage } from '@/app/chat/transcript-backfill'
import { useMessageStream } from '@/app/session/hooks/use-message-stream'
import { usePromptActions } from '@/app/session/hooks/use-prompt-actions'
import { useSessionStateCache } from '@/app/session/hooks/use-session-state-cache'
import { stubThreadEnvironment } from '@/components/assistant-ui/test-utils'
import { getLatestSessionMessages } from '@/hermes'
import { chatMessageText, toChatMessages } from '@/lib/chat-messages'
import { resetLiveSync } from '@/store/live-sync'
import {
  $busy,
  setActiveSessionId,
  setAwaitingResponse,
  setBusy,
  setMessages,
  setSelectedStoredSessionId
} from '@/store/session'
import { $sessionStates, $sessionTiles, clearAllSessionStates } from '@/store/session-states'
import {
  $retainedTodosBySession,
  $todosBySession,
  clearSessionTodos,
  restoreSessionTodosFromSnapshot,
  setSessionTodos
} from '@/store/todos'
import type { SessionMessage } from '@/types/hermes'

import {
  hydrateStoredSessionTranscript,
  reconcileActiveTranscript,
  reconcileTileTranscripts,
  useBackgroundSync
} from './use-background-sync'

vi.mock('@/hermes', async original => ({
  ...(await original<Record<string, unknown>>()),
  getLatestSessionMessages: vi.fn()
}))

stubThreadEnvironment()

const RUNTIME = 'refresh-runtime'
const STORED = 'refresh-stored'
const FINAL = 'The completed answer must stay visible.'

const history: SessionMessage[] = [
  { id: 1, role: 'user', content: 'Earlier question', timestamp: 1 },
  { id: 2, role: 'assistant', content: 'Earlier answer', timestamp: 2 },
  { id: 3, role: 'user', content: 'Latest question', timestamp: 3 }
]

const toolRound: SessionMessage[] = [
  ...history,
  {
    id: 4,
    role: 'assistant',
    content: '',
    timestamp: 4,
    tool_calls: [
      { id: 'read-tool', type: 'function', function: { name: 'read_file', arguments: '{"path":"example.txt"}' } }
    ]
  },
  { id: 5, role: 'tool', content: 'example content', timestamp: 5, tool_call_id: 'read-tool', tool_name: 'read_file' }
]

const completeHistory: SessionMessage[] = [...toolRound, { id: 6, role: 'assistant', content: FINAL, timestamp: 6 }]
const noop = async () => undefined
let cache: ReturnType<typeof useSessionStateCache>
let stream: ReturnType<typeof useMessageStream>
let refresh: () => Promise<void>
let restoreCheckpoint: ReturnType<typeof usePromptActions>['restoreToMessage']
const checkpointRequest = vi.fn(async () => ({}) as never)

function ObserveRuntime() {
  const messages = useAuiState(state => state.thread.messages)

  return (
    <output data-testid="runtime">
      {messages
        .map(message =>
          message.content
            .filter(part => part.type === 'text')
            .map(part => part.text)
            .join('')
        )
        .join('\n')}
    </output>
  )
}

function Harness({
  backgroundSync = false,
  tile = false,
  fallback = false
}: {
  backgroundSync?: boolean
  tile?: boolean
  fallback?: boolean
}) {
  const busyRef = useRef(false)
  const queryClient = useRef(new QueryClient()).current
  const requestSequenceRef = useRef(0)
  const signatureRef = useRef(new Map<string, string>())
  cache = useSessionStateCache({
    activeSessionId: tile ? 'other-runtime' : RUNTIME,
    selectedStoredSessionId: tile ? 'other-stored' : STORED,
    busyRef,
    setBusy,
    setAwaitingResponse,
    setMessages
  })
  const { activeSessionIdRef, selectedStoredSessionIdRef, updateSessionState } = cache

  const promptActions = usePromptActions({
    activeSessionId: RUNTIME,
    activeSessionIdRef,
    branchCurrentSession: async () => true,
    busyRef,
    createBackendSessionForSend: async () => RUNTIME,
    getRoutedStoredSessionId: () => STORED,
    getRuntimeIdForStoredSession: () => RUNTIME,
    getRouteToken: () => 'checkpoint-test',
    handleSkinCommand: () => '',
    openMemoryGraph: () => undefined,
    refreshSessions: noop,
    requestGateway: checkpointRequest,
    resumeStoredSession: noop,
    runtimeIdByStoredSessionIdRef: useRef(new Map([[STORED, RUNTIME]])),
    selectedStoredSessionIdRef,
    startFreshSessionDraft: () => undefined,
    sttEnabled: false,
    updateSessionState
  })

  restoreCheckpoint = promptActions.restoreToMessage

  const hydrate = useCallback(
    async (attempts = 1, storedSessionId: string | null = STORED, runtimeSessionId: string | null = RUNTIME) => {
      if (storedSessionId && runtimeSessionId) {
        await hydrateStoredSessionTranscript({
          attempts,
          storedSessionId,
          runtimeSessionId,
          storedProfile: 'default',
          updateSessionState
        })
      }
    },
    [updateSessionState]
  )

  stream = useMessageStream({
    ...cache,
    queryClient,
    hydrateFromStoredSession: fallback ? hydrate : noop,
    refreshHermesConfig: noop,
    refreshSessions: noop
  })
  refresh = useCallback(
    () =>
      tile
        ? reconcileTileTranscripts({
            requestSequenceRef,
            signatureRef,
            updateSessionState,
            tiles: [{ runtimeId: RUNTIME, storedSessionId: STORED }]
          })
        : reconcileActiveTranscript({
            activeSessionIdRef,
            selectedStoredSessionIdRef,
            updateSessionState,
            busyRef,
            requestSequenceRef,
            signatureRef,
            resolveSession: () => ({ profile: 'default' })
          }),
    [activeSessionIdRef, selectedStoredSessionIdRef, updateSessionState, tile]
  )
  useBackgroundSync({
    activeConnectionId: 'local',
    activeGatewayProfile: 'default',
    activeIsMessaging: false,
    activeSessionId: tile ? 'other-runtime' : RUNTIME,
    activeStoredSessionId: tile ? 'other-stored' : STORED,
    freshDraftReady: false,
    gatewayState: backgroundSync ? 'open' : 'closed',
    refreshActiveTranscript: refresh,
    refreshCronJobs: noop,
    refreshCurrentModel: noop,
    refreshHermesConfig: noop,
    refreshMessagingSessions: noop,
    refreshSessions: noop,
    requestGateway: async () => ({ sessions: [] }) as never,
    updateSessionState: cache.updateSessionState
  })
  const busy = useStore(PRIMARY_SESSION_VIEW.$busy)

  return (
    <ChatRuntimeBoundary
      busy={busy}
      onCancel={noop}
      onEdit={noop}
      onReload={noop}
      onThreadMessagesChange={noop}
      suppressMessages={false}
    >
      <ObserveRuntime />
    </ChatRuntimeBoundary>
  )
}

function send(type: GatewayEvent['type'], payload: GatewayEvent['payload'] = {}) {
  act(() => stream.handleGatewayEvent({ session_id: RUNTIME, type, payload }))
}

function deferredHistory() {
  let resolve!: (page: Awaited<ReturnType<typeof getLatestSessionMessages>>) => void

  const promise = new Promise<Awaited<ReturnType<typeof getLatestSessionMessages>>>(yes => {
    resolve = yes
  })

  return { promise, resolve }
}

async function finishTurn() {
  send('message.start')
  send('tool.start', { name: 'read_file', tool_id: 'read-tool', args: { path: 'example.txt' } })
  send('tool.complete', { name: 'read_file', tool_id: 'read-tool', result: 'example content' })
  send('message.delta', { text: FINAL })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  send('message.complete', { text: FINAL })
}

beforeEach(() => {
  vi.useFakeTimers()
  checkpointRequest.mockReset()
  vi.mocked(getLatestSessionMessages).mockReset()
  setActiveSessionId(RUNTIME)
  setSelectedStoredSessionId(STORED)
})

afterEach(() => {
  cleanup()
  clearSessionTodos(RUNTIME)
  clearAllSessionStates()
  $sessionTiles.set([])
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

it.each([
  { lateReceipt: false, repeated: false },
  { lateReceipt: true, repeated: false },
  { lateReceipt: false, repeated: true },
  { lateReceipt: true, repeated: true }
])('恢复检查点后只显示一次原提示词（回执迟到=$lateReceipt，前文同文=$repeated）', async ({ lateReceipt, repeated }) => {
  const prefix: SessionMessage[] = repeated
    ? [
        { id: 31, role: 'user', content: '你好', timestamp: 0.1 },
        { id: 32, role: 'assistant', content: '前一轮回答', timestamp: 0.2 }
      ]
    : []

  const oldHistory: SessionMessage[] = [
    ...prefix,
    { id: 41, role: 'user', content: '你好', timestamp: 1 },
    { id: 42, role: 'assistant', content: '旧回答', timestamp: 2 }
  ]

  const freshHistory: SessionMessage[] = [
    ...prefix,
    { id: 43, role: 'user', content: '你好', timestamp: 3 },
    { id: 44, role: 'assistant', content: '新回答', timestamp: 4 }
  ]

  let accept!: (value: never) => void
  checkpointRequest.mockReturnValue(
    new Promise(resolve => {
      accept = resolve
    })
  )
  render(<Harness />)
  act(() => cache.updateSessionState(RUNTIME, state => ({ ...state, messages: toChatMessages(oldHistory) }), STORED))
  const source = $sessionStates.get()[RUNTIME].messages[prefix.length]
  let restored!: Promise<void>
  await act(async () => {
    restored = restoreCheckpoint(source.id)
  })
  const receipt = { user_row_id: 43, survivor_row_id_map: { '41': null, '42': null } } as never

  if (!lateReceipt) {
    await act(async () => {
      accept(receipt)
      await restored
    })
  }

  send('message.start')
  send('message.delta', { text: '新回答' })
  await act(async () => vi.advanceTimersByTimeAsync(100))
  send('message.complete', {
    text: '新回答',
    persisted_turn: { user_row_id: 43, final_assistant_row_id: 44, row_ids: [43, 44], complete: true }
  })
  vi.mocked(getLatestSessionMessages).mockResolvedValue({ session_id: STORED, messages: freshHistory })
  await act(async () => refresh())

  if (lateReceipt) {
    await act(async () => {
      accept(receipt)
      await restored
    })
  }

  const expected = [...prefix.map(message => message.content), '你好', '新回答']
  expect($sessionStates.get()[RUNTIME].messages.map(chatMessageText)).toEqual(expected)
  expect(screen.getByTestId('runtime').textContent).toBe(expected.join('\n'))
  const users = $sessionStates.get()[RUNTIME].messages.filter(message => message.role === 'user')
  expect(users.at(-1)?.rowId).toBe(43)
})

it('keeps an idle Todo snapshot for review when post-turn history refresh clears the live panel', async () => {
  const todos = [{ id: 'next', content: 'Next task', status: 'in_progress' as const }]

  const saved: SessionMessage[] = [
    ...history,
    {
      id: 4,
      role: 'assistant',
      content: '',
      timestamp: 4,
      tool_calls: [{ id: 'todo-call', type: 'function', function: { name: 'todo_list', arguments: '{}' } }]
    },
    {
      id: 5,
      role: 'tool',
      content: JSON.stringify({ todos, revision: 3 }),
      timestamp: 5,
      tool_call_id: 'todo-call',
      tool_name: 'todo_list'
    },
    { id: 6, role: 'assistant', content: FINAL, timestamp: 6 }
  ]

  render(<Harness />)
  act(() => restoreSessionTodosFromSnapshot(RUNTIME, { todos, revision: 3 }, false))
  expect($retainedTodosBySession.get()[RUNTIME]).toEqual(todos)
  vi.mocked(getLatestSessionMessages).mockResolvedValueOnce({ session_id: STORED, messages: saved })

  await act(async () => {
    await hydrateStoredSessionTranscript({
      attempts: 1,
      storedSessionId: STORED,
      runtimeSessionId: RUNTIME,
      storedProfile: 'default',
      updateSessionState: cache.updateSessionState
    })
  })
  expect($todosBySession.get()[RUNTIME]).toBeUndefined()
  expect($retainedTodosBySession.get()[RUNTIME]).toEqual(todos)

  // Deferred Desktop resumes initially return no todo_state. The subsequent
  // persisted transcript fetch must provide the same read-only list by itself.
  act(() => clearSessionTodos(RUNTIME))
  vi.mocked(getLatestSessionMessages).mockResolvedValueOnce({ session_id: STORED, messages: saved })
  await act(async () => {
    await hydrateStoredSessionTranscript({
      attempts: 1,
      storedSessionId: STORED,
      runtimeSessionId: RUNTIME,
      storedProfile: 'default',
      updateSessionState: cache.updateSessionState
    })
  })
  expect($retainedTodosBySession.get()[RUNTIME]).toEqual(todos)

  // A legacy unversioned empty result is still an explicit clear. An older
  // revisioned snapshot must not keep the previous button pinned.
  const cleared: SessionMessage[] = [
    ...saved,
    {
      id: 7,
      role: 'assistant',
      content: '',
      timestamp: 7,
      tool_calls: [{ id: 'clear-call', type: 'function', function: { name: 'todo_list', arguments: '{"todos":[]}' } }]
    },
    { id: 8, role: 'tool', content: '{"todos":[]}', timestamp: 8, tool_call_id: 'clear-call', tool_name: 'todo_list' }
  ]

  vi.mocked(getLatestSessionMessages).mockResolvedValueOnce({ session_id: STORED, messages: cleared })
  await act(async () => {
    await hydrateStoredSessionTranscript({
      attempts: 1,
      storedSessionId: STORED,
      runtimeSessionId: RUNTIME,
      storedProfile: 'default',
      updateSessionState: cache.updateSessionState
    })
  })
  expect($retainedTodosBySession.get()[RUNTIME]).toBeUndefined()
})

it.each([false, true])(
  'rejects a history read spanning a completed turn, then accepts fresh history (tile: %s)',
  async tile => {
    if (tile) {
      setActiveSessionId('other-runtime')
      setSelectedStoredSessionId('other-stored')
      $sessionTiles.set([{ runtimeId: RUNTIME, storedSessionId: STORED }])
    }

    render(<Harness tile={tile} />)
    act(() => cache.updateSessionState(RUNTIME, state => ({ ...state, messages: toChatMessages(history) }), STORED))
    const delayed = deferredHistory()
    vi.mocked(getLatestSessionMessages).mockReturnValueOnce(delayed.promise)
    const pending = refresh()
    await finishTurn()
    const completed = $sessionStates.get()[RUNTIME].messages
    expect(completed.map(chatMessageText)).toContain(FINAL)

    if (!tile) {
      expect(screen.getByTestId('runtime').textContent).toContain(FINAL)
    }

    await act(async () => {
      delayed.resolve({ session_id: STORED, messages: toolRound })
      await pending
    })
    expect.soft($sessionStates.get()[RUNTIME].messages).toBe(completed)

    if (!tile) {
      expect.soft(screen.getByTestId('runtime').textContent).toContain(FINAL)
    }

    vi.mocked(getLatestSessionMessages).mockResolvedValueOnce({ session_id: STORED, messages: completeHistory })
    await act(async () => {
      await refresh()
    })
    const texts = $sessionStates.get()[RUNTIME].messages.map(chatMessageText)
    expect(texts.filter(text => text.includes(FINAL))).toHaveLength(1)
    expect(texts).toContain('Earlier answer')
  }
)

it('retries an interrupted reconnect read once on idle, even before that read returns', async () => {
  const stale = deferredHistory()
  const fresh = deferredHistory()
  vi.mocked(getLatestSessionMessages).mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
  render(<Harness backgroundSync />)
  act(() => cache.updateSessionState(RUNTIME, state => ({ ...state, messages: toChatMessages(history) }), STORED))
  await finishTurn()
  expect.soft(getLatestSessionMessages).toHaveBeenCalledTimes(2)

  await act(async () => {
    fresh.resolve({ session_id: STORED, messages: completeHistory })
    await fresh.promise
    stale.resolve({ session_id: STORED, messages: toolRound })
    await stale.promise
  })
  expect.soft(screen.getByTestId('runtime').textContent).toContain(FINAL)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect.soft(getLatestSessionMessages).toHaveBeenCalledTimes(2)
  const texts = $sessionStates.get()[RUNTIME].messages.map(chatMessageText)
  expect(texts.filter(text => text.includes(FINAL))).toHaveLength(1)
})

it.each([
  { tile: false, mutation: 'backfill' },
  { tile: true, mutation: 'backfill' },
  { tile: false, mutation: 'retention' },
  { tile: true, mutation: 'retention' }
])('accepts an external answer during prefix-only $mutation (tile: $tile)', async ({ tile, mutation }) => {
  if (tile) {
    setActiveSessionId('other-runtime')
    setSelectedStoredSessionId('other-stored')
    $sessionTiles.set([{ runtimeId: RUNTIME, storedSessionId: STORED }])
  }

  render(<Harness tile={tile} />)
  act(() => cache.updateSessionState(RUNTIME, state => ({ ...state, messages: toChatMessages(history) }), STORED))
  const delayed = deferredHistory()
  vi.mocked(getLatestSessionMessages).mockReturnValueOnce(delayed.promise)
  const pending = refresh()
  const older = toChatMessages([{ id: 0, role: 'assistant', content: 'Backfilled answer', timestamp: 0 }])
  act(() =>
    cache.updateSessionState(
      RUNTIME,
      state => ({
        ...state,
        // Retention releases a prefix with slice; backfill prepends older rows.
        // Neither changes the existing tail nor emits a busy edge.
        messages: mutation === 'backfill' ? mergeOlderTranscriptPage(state.messages, older) : state.messages.slice(1)
      }),
      STORED
    )
  )
  await act(async () => {
    delayed.resolve({
      session_id: STORED,
      messages: [...history, { id: 4, role: 'assistant', content: 'External answer', timestamp: 4 }]
    })
    await pending
  })
  const texts = $sessionStates.get()[RUNTIME].messages.map(chatMessageText)
  expect(texts).toContain('External answer')
  expect(texts).toContain('Earlier answer')

  if (mutation === 'backfill') {
    expect(texts).toContain('Backfilled answer')
  }

  expect(getLatestSessionMessages).toHaveBeenCalledTimes(1)
})

it('rejects a read when an existing row changes even if the last row is untouched', async () => {
  render(<Harness />)
  act(() => cache.updateSessionState(RUNTIME, state => ({ ...state, messages: toChatMessages(history) }), STORED))
  const delayed = deferredHistory()
  vi.mocked(getLatestSessionMessages).mockReturnValueOnce(delayed.promise)
  const pending = refresh()
  act(() =>
    cache.updateSessionState(
      RUNTIME,
      state => ({
        ...state,
        messages: state.messages.map((message, index) =>
          index === 1 ? { ...message, parts: [{ type: 'text' as const, text: 'Edited answer' }] } : message
        )
      }),
      STORED
    )
  )
  await act(async () => {
    delayed.resolve({ session_id: STORED, messages: history })
    await pending
  })
  expect($sessionStates.get()[RUNTIME].messages.map(chatMessageText)).toContain('Edited answer')
})

it('keeps the reply and retries when a complete turn fits between view animation frames', async () => {
  const stale = deferredHistory()
  vi.mocked(getLatestSessionMessages)
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValue({ session_id: STORED, messages: completeHistory })
  render(<Harness backgroundSync />)
  act(() => cache.updateSessionState(RUNTIME, state => ({ ...state, messages: toChatMessages(history) }), STORED))
  const busyEdges: boolean[] = []
  const unsubscribe = $busy.listen(value => busyEdges.push(value))
  await act(async () => {
    stream.handleGatewayEvent({ session_id: RUNTIME, type: 'message.start', payload: {} })
    stream.handleGatewayEvent({ session_id: RUNTIME, type: 'message.delta', payload: { text: FINAL } })
    stream.handleGatewayEvent({ session_id: RUNTIME, type: 'message.complete', payload: { text: FINAL } })
  })
  unsubscribe()
  expect(busyEdges).not.toContain(true)
  expect(screen.getByTestId('runtime').textContent).toContain(FINAL)
  expect.soft(getLatestSessionMessages).toHaveBeenCalledTimes(2)
  await act(async () => {
    stale.resolve({ session_id: STORED, messages: toolRound })
    await stale.promise
  })
  expect(screen.getByTestId('runtime').textContent).toContain(FINAL)
  expect(getLatestSessionMessages).toHaveBeenCalledTimes(2)
})

it('rejects post-turn fallback history overtaken by another completed turn, including its todo restore', async () => {
  render(<Harness fallback />)
  act(() =>
    cache.updateSessionState(RUNTIME, state => ({ ...state, messages: toChatMessages(history.slice(-1)) }), STORED)
  )
  const stale = deferredHistory()
  vi.mocked(getLatestSessionMessages).mockReturnValueOnce(stale.promise)
  send('message.start')
  send('message.complete')
  expect(getLatestSessionMessages).toHaveBeenCalledTimes(1)
  await finishTurn()
  act(() => setSessionTodos(RUNTIME, [{ id: 'new-todo', content: 'New turn todo', status: 'pending' }]))
  await act(async () => {
    stale.resolve({ session_id: STORED, messages: toolRound })
    await stale.promise
  })
  expect.soft(screen.getByTestId('runtime').textContent).toContain(FINAL)
  expect($todosBySession.get()[RUNTIME]).toEqual([{ id: 'new-todo', content: 'New turn todo', status: 'pending' }])
})

it('still hydrates a missing completion after a transient read failure', async () => {
  render(<Harness fallback />)
  act(() =>
    cache.updateSessionState(RUNTIME, state => ({ ...state, messages: toChatMessages(history.slice(-1)) }), STORED)
  )
  vi.mocked(getLatestSessionMessages)
    .mockRejectedValueOnce(new Error('transient read failure'))
    .mockResolvedValueOnce({ session_id: STORED, messages: completeHistory })
  send('message.start')
  send('message.complete')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(getLatestSessionMessages).toHaveBeenCalledTimes(2)
  expect(screen.getByTestId('runtime').textContent).toContain(FINAL)
})

it.each(['unmount', 'navigation'] as const)('retires an interrupted refresh on %s', async mode => {
  const stale = deferredHistory()
  vi.mocked(getLatestSessionMessages).mockReturnValueOnce(stale.promise)
  const view = render(<Harness backgroundSync />)
  act(() => cache.updateSessionState(RUNTIME, state => ({ ...state, messages: toChatMessages(history) }), STORED))
  send('message.start')

  if (mode === 'unmount') {
    view.unmount()
  } else {
    act(() => {
      setActiveSessionId('other-runtime')
      setSelectedStoredSessionId('other-stored')
    })
    view.rerender(<Harness backgroundSync tile />)
  }

  await finishTurn()
  await act(async () => {
    stale.resolve({ session_id: STORED, messages: toolRound })
    await stale.promise
  })

  if (mode === 'navigation') {
    act(() => {
      setActiveSessionId(RUNTIME)
      setSelectedStoredSessionId(STORED)
    })
    view.rerender(<Harness backgroundSync />)
    await finishTurn()
  }

  expect(getLatestSessionMessages).toHaveBeenCalledTimes(1)
})

it('does not let an older finalizer retire the newest refresh observation', async () => {
  const stale = deferredHistory()
  const replacement = deferredHistory()
  vi.mocked(getLatestSessionMessages)
    .mockReturnValueOnce(stale.promise)
    .mockReturnValueOnce(replacement.promise)
    .mockResolvedValue({ session_id: STORED, messages: completeHistory })
  const view = render(<Harness backgroundSync />)
  act(() => cache.updateSessionState(RUNTIME, state => ({ ...state, messages: toChatMessages(history) }), STORED))
  // Close/reopen creates a fresh scoped connect read while the old one waits.
  view.rerender(<Harness />)
  view.rerender(<Harness backgroundSync />)
  expect(getLatestSessionMessages).toHaveBeenCalledTimes(2)
  await act(async () => {
    stale.resolve({ session_id: STORED, messages: history })
    await stale.promise
  })
  await finishTurn()
  await act(async () => {
    replacement.resolve({ session_id: STORED, messages: toolRound })
    await replacement.promise
  })
  expect(getLatestSessionMessages).toHaveBeenCalledTimes(3)
  expect(screen.getByTestId('runtime').textContent).toContain(FINAL)
})
