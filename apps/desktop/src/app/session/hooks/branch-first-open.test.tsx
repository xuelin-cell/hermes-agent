import { useStore } from '@nanostores/react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'

import { getLatestSessionMessages, type SessionInfo, type SessionMessagesResponse } from '@/hermes'
import { chatMessageText } from '@/lib/chat-messages'
import { requestGatewayForAgent, requestGatewayForProfile } from '@/store/gateway'
import {
  $activeSessionId,
  $freshDraftReady,
  $messages,
  $resumeExhaustedSessionId,
  $resumeFailedSessionId,
  $selectedStoredSessionId,
  $sessionResumeRequest,
  setActiveSessionId,
  setAwaitingResponse,
  setBusy,
  setMessages,
  setSelectedStoredSessionId,
  setSessions
} from '@/store/session'
import { clearAllSessionStates } from '@/store/session-states'

import { deferred } from '../../../test/deferred'
import { sessionRoute } from '../../routes'

import { useRouteResume } from './use-route-resume'
import { useSessionActions } from './use-session-actions'
import { useSessionStateCache } from './use-session-state-cache'

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLatestSessionMessages: vi.fn()
}))

vi.mock('@/store/profile', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureGatewayAgent: vi.fn().mockResolvedValue(undefined),
  ensureGatewayProfile: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestGatewayForAgent: vi.fn(),
  requestGatewayForProfile: vi.fn()
}))

type Actions = ReturnType<typeof useSessionActions>
type RequestGateway = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

/** 使用真实会话缓存与路由恢复钩子，模拟路由在导航回调之后提交。 */
function BranchRouteHarness({
  onReady,
  requestGateway
}: {
  onReady: (actions: Actions, navigate: (path: string) => void) => void
  requestGateway: RequestGateway
}) {
  const [pathname, setPathname] = useState(sessionRoute('parent'))
  const route = useRef(pathname)
  route.current = pathname
  const activeSessionId = useStore($activeSessionId)
  const selectedStoredSessionId = useStore($selectedStoredSessionId)
  const freshDraftReady = useStore($freshDraftReady)
  const resumeFailedSessionId = useStore($resumeFailedSessionId)
  const resumeExhaustedSessionId = useStore($resumeExhaustedSessionId)
  const sessionResumeRequest = useStore($sessionResumeRequest)
  const busyRef = useRef(false)
  const creatingSessionRef = useRef(false)

  const cache = useSessionStateCache({
    activeSessionId,
    busyRef,
    selectedStoredSessionId,
    setMessages,
    setBusy,
    setAwaitingResponse
  })

  const { ensureSessionState } = cache

  /** 导航先返回，再提交新路由，覆盖首次创建分支的竞态。 */
  function navigate(path: string) {
    queueMicrotask(() => flushSync(() => setPathname(path)))
  }

  const actions = useSessionActions({
    ...cache,
    activeSessionId,
    selectedStoredSessionId,
    busyRef,
    creatingSessionRef,
    getRouteToken: () => route.current,
    getRoutedStoredSessionId: () => route.current.slice(1),
    navigate: navigate as never,
    requestGateway
  })

  // 父会话在挂载前已经打开，复用它的运行时与历史缓存。
  useEffect(() => {
    ensureSessionState('rt-parent', 'parent')
  }, [ensureSessionState])

  useRouteResume({
    ...cache,
    activeSessionId,
    selectedStoredSessionId,
    creatingSessionRef,
    currentView: 'chat',
    gatewayState: 'open',
    locationPathname: pathname,
    routedSessionId: pathname.slice(1),
    freshDraftReady,
    resumeFailedSessionId,
    resumeExhaustedSessionId,
    sessionResumeRequest,
    resumeSession: actions.resumeSession,
    startFreshSessionDraft: actions.startFreshSessionDraft
  })

  useEffect(() => {
    onReady(actions, navigate)
  })

  return <output data-testid="route">{pathname}</output>
}

/** 构造真实侧栏行，父会话和目标会话分别拥有两条历史。 */
function storedSession(id: string): SessionInfo {
  return {
    id,
    title: id,
    source: 'desktop',
    started_at: 1,
    last_active: 1,
    ended_at: null,
    is_active: false,
    message_count: 2,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    model: null,
    preview: null
  }
}

/** 仅控制后端响应，前端仍走正式创建、恢复和历史加载流程。 */
function prepare() {
  const rows = [
    { role: 'user', content: 'original question', timestamp: 1 },
    { role: 'assistant', content: 'original answer', timestamp: 2 }
  ]

  const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'session.branch_whole' || method === 'session.branch_stored') {
      return {
        session_id: 'rt-child',
        stored_session_id: 'child',
        message_count: 2,
        messages_omitted: true,
        info: {}
      } as never
    }

    const id = String(params?.session_id).replace(/^rt-/, '')

    return {
      session_id: `rt-${id}`,
      session_key: id,
      resumed: id,
      message_count: 2,
      messages: id === 'other' ? [{ role: 'assistant', content: 'other answer' }] : rows,
      running: false,
      info: {}
    } as never
  })

  vi.mocked(requestGatewayForProfile).mockImplementation(((
    _profile: string,
    method: string,
    params?: Record<string, unknown>
  ) => requestGateway(method, params)) as never)
  vi.mocked(requestGatewayForAgent).mockImplementation(((
    _connection: string,
    _profile: string,
    method: string,
    params?: Record<string, unknown>
  ) => requestGateway(method, params)) as never)
  vi.mocked(getLatestSessionMessages).mockImplementation(
    async id =>
      ({
        session_id: id,
        messages: id === 'other' ? [{ role: 'assistant', content: 'other answer' }] : rows
      }) as SessionMessagesResponse
  )
  setSessions([storedSession('parent'), storedSession('other')])
  setActiveSessionId('rt-parent')
  setSelectedStoredSessionId('parent')
  setMessages([{ id: 'parent-answer', role: 'assistant', parts: [{ type: 'text', text: 'original answer' }] }])

  return { requestGateway, rows }
}

afterEach(() => {
  cleanup()
  clearAllSessionStates()
  setActiveSessionId(null)
  setSelectedStoredSessionId(null)
  setMessages([])
  setSessions([])
  $sessionResumeRequest.set(null)
  vi.clearAllMocks()
})

it.each(['current', 'stored'])('首次通过 %s 创建分支就自动加载历史，再次选择保留同一分支', async source => {
  const { requestGateway } = prepare()
  let actions!: Actions

  const view = render(
    <BranchRouteHarness
      onReady={value => {
        actions = value
      }}
      requestGateway={requestGateway}
    />
  )

  await act(async () => {
    expect(await (source === 'current' ? actions.branchCurrentSession() : actions.branchStoredSession('parent'))).toBe(
      true
    )
  })
  await waitFor(() => expect($activeSessionId.get()).toBe('rt-child'))
  await waitFor(() => expect($messages.get().map(chatMessageText)).toEqual(['original question', 'original answer']))
  expect(view.getByTestId('route').textContent).toBe(sessionRoute('child'))
  expect($selectedStoredSessionId.get()).toBe('child')
  await act(async () => {
    await actions.resumeSession('child')
  })
  expect(requestGateway.mock.calls.filter(([method]) => method.startsWith('session.branch'))).toHaveLength(1)
  expect($messages.get()).toHaveLength(2)
})

it('分支历史迟到时继续停留在用户后来选择的会话', async () => {
  const { requestGateway, rows } = prepare()
  const history = deferred<SessionMessagesResponse>()
  vi.mocked(getLatestSessionMessages).mockImplementation(async id =>
    id === 'child'
      ? history.promise
      : ({ session_id: id, messages: [{ role: 'assistant', content: 'other answer' }] } as SessionMessagesResponse)
  )
  let actions!: Actions
  let navigate!: (path: string) => void

  const view = render(
    <BranchRouteHarness
      onReady={(value, go) => {
        actions = value
        navigate = go
      }}
      requestGateway={requestGateway}
    />
  )

  await act(async () => {
    await actions.branchCurrentSession()
  })
  await waitFor(() => expect(getLatestSessionMessages).toHaveBeenCalledWith('child', expect.anything()))
  await act(async () => {
    navigate(sessionRoute('other'))
  })
  await waitFor(() => expect($activeSessionId.get()).toBe('rt-other'))
  await act(async () => {
    history.resolve({ session_id: 'child', messages: rows } as SessionMessagesResponse)
  })
  expect(view.getByTestId('route').textContent).toBe(sessionRoute('other'))
  expect($selectedStoredSessionId.get()).toBe('other')
  expect($messages.get().map(chatMessageText)).toEqual(['other answer'])
})
