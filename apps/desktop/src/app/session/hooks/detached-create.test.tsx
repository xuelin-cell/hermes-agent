import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetDetachedCreateForTests, takeDetachedCreate } from '@/app/session/detached-create-mt'
import { useI18n } from '@/i18n'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $activeGatewayProfile, $newChatConnectionId, $newChatProfile, $newChatRoute } from '@/store/profile'
import { $projectScope, ALL_PROJECTS } from '@/store/project-scope'
import {
  $activeSessionId,
  $freshDraftReady,
  $selectedStoredSessionId,
  $sessions,
  _resetSessionOwnerHintsForTests,
  setActiveSessionId,
  setConnection,
  setCurrentCwdExplicit,
  setCurrentCwdTransient,
  setNewChatWorkspaceTarget,
  setSelectedStoredSessionId,
  setSessions,
  setYoloActive
} from '@/store/session'

import { useSubmitPrompt } from './use-prompt-actions/submit'
import { useSessionActions } from './use-session-actions'

vi.mock('@/hermes', async original => ({
  ...(await original<Record<string, unknown>>()),
  getLatestSessionMessages: vi.fn(async () => ({ messages: [], session_id: 'session' }))
}))

vi.mock('@/store/profile', async original => ({
  ...(await original<Record<string, unknown>>()),
  ensureGatewayAgent: vi.fn(async () => undefined),
  ensureGatewayProfile: vi.fn(async () => undefined)
}))
vi.mock('@/store/gateway', async original => ({
  ...(await original<Record<string, unknown>>()),
  requestGatewayForAgent: vi.fn(),
  retainGatewayForAgent: vi.fn(async () => () => undefined)
}))

const RUNTIME = 'rt-first'
const STORED = 'stored-first'

/** session.create 挂起，由测试决定何时返回——模拟后端忙时创建会话的那段等待。 */
function deferredCreate(pauseYolo = false) {
  let resolve: () => void = () => undefined
  const pending = new Promise<void>(done => (resolve = done))
  let releaseYolo: () => void = () => undefined
  const pendingYolo = new Promise<void>(done => (releaseYolo = done))

  const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (pauseYolo && method === 'config.set' && params?.key === 'yolo') {
      await pendingYolo
    }

    if (method === 'config.get' && params?.key === 'project') {
      return { cwd: 'C:\\uniworker\\acc\\workspace' }
    }

    if (method === 'session.create') {
      await pending

      return { info: {}, session_id: RUNTIME, stored_session_id: STORED }
    }

    return {}
  })

  return { release: resolve, releaseYolo, requestGateway }
}

/** 挂载真实创建逻辑，并允许测试在异步等待期间切换路由。 */
function mountActions(requestGateway: ReturnType<typeof deferredCreate>['requestGateway']) {
  const ref = <T,>(current: T) => ({ current })
  let state = createClientSessionState()
  const navigate = vi.fn()

  const updateSessionState = vi.fn((_id: string, update: (value: typeof state) => typeof state) => {
    state = update(state)

    return state
  })

  const activeSessionIdRef = ref<string | null>(null)
  const busyRef = ref(false)
  const selectedStoredSessionIdRef = ref<string | null>(null)
  const route = { current: '/::' }

  const result = renderHook(() => {
    const { t } = useI18n()

    const actions = useSessionActions({
      activeSessionId: null,
      activeSessionIdRef,
      busyRef,
      creatingSessionRef: ref(false),
      ensureSessionState: () => state,
      getRouteToken: () => route.current,
      getRoutedStoredSessionId: () => null,
      navigate,
      requestGateway: requestGateway as never,
      resetViewSync: vi.fn(),
      runtimeIdByStoredSessionIdRef: ref(new Map()),
      selectedStoredSessionId: null,
      selectedStoredSessionIdRef,
      sessionStateByRuntimeIdRef: ref(new Map()),
      syncSessionStateToView: vi.fn(),
      updateSessionState: updateSessionState as never
    })

    const submit = useSubmitPrompt({
      activeSessionIdRef,
      busyRef,
      copy: t.desktop,
      createBackendSessionForSend: actions.createBackendSessionForSend,
      getRouteToken: () => route.current,
      getRoutedStoredSessionId: () => null,
      getRuntimeIdForStoredSession: () => null,
      requestGateway: requestGateway as never,
      runtimeIdByStoredSessionIdRef: ref(new Map()),
      resumeStoredSession: () => undefined,
      selectedStoredSessionIdRef,
      syncAttachmentsForSubmit: async sessionId => ({ sessionId, attachments: [] }),
      updateSessionState: updateSessionState as never
    })

    return { ...actions, submit }
  })

  return { ...result, navigate, route, selectedStoredSessionIdRef, updateSessionState }
}

const navigatedToCreated = (navigate: ReturnType<typeof vi.fn>) =>
  navigate.mock.calls.some(([route]) => String(route).includes(STORED))

/** 第一个新对话发出、会话还没建好时，按需再开一个新对话，然后让创建返回。 */
async function sendThenMaybeOpenNewChat(
  openNewChat: boolean,
  createArgs: Parameters<ReturnType<typeof useSessionActions>['createBackendSessionForSend']> = ['第一条']
) {
  const gateway = deferredCreate()
  const mounted = mountActions(gateway.requestGateway)
  let created: Promise<null | string> = Promise.resolve(null)

  await act(async () => {
    created = mounted.result.current.createBackendSessionForSend(...createArgs)
    await Promise.resolve()
  })

  if (openNewChat) {
    act(() => mounted.result.current.startFreshSessionDraft())
  }

  let runtimeId: null | string = null

  await act(async () => {
    gateway.release()
    runtimeId = await created
  })

  return { ...mounted, requestGateway: gateway.requestGateway, runtimeId }
}

beforeEach(() => {
  _resetDetachedCreateForTests()
  _resetSessionOwnerHintsForTests()
  $newChatRoute.set(null)
  $newChatProfile.set('default')
  $newChatConnectionId.set(null)
  $activeGatewayProfile.set('default')
  $projectScope.set(ALL_PROJECTS)
  setSessions([])
  setActiveSessionId(null)
  setSelectedStoredSessionId(null)
  setNewChatWorkspaceTarget(undefined)
  setCurrentCwdTransient('')
  setCurrentCwdExplicit(false)
  setYoloActive(false)
  setConnection({ baseUrl: 'http://127.0.0.1:9119', mode: 'local' } as never)
  window.hermesDesktop = {
    createConversationFolder: vi.fn(async () => 'C:\\uniworker\\acc\\workspace\\20261022-120000'),
    discardConversationFolder: vi.fn(async () => undefined)
  } as never
})

afterEach(() => {
  cleanup()
  setConnection(null)
  setSessions([])
  setYoloActive(false)
  window.hermesDesktop = undefined as never
  vi.clearAllMocks()
})

describe('新对话发出后、会话建好前又开了新对话（desktop-mt）', () => {
  it.each(['existing', 'fresh', 'yolo'] as const)(
    '真实创建和发送逻辑串联：%s 期间切走仍只提交一次',
    async destination => {
      const gateway = deferredCreate(destination === 'yolo')
      const mounted = mountActions(gateway.requestGateway)

      if (destination === 'yolo') {
        setYoloActive(true)
      }

      const sending = mounted.result.current.submit('第一条')
      await vi.waitFor(() => expect(gateway.requestGateway).toHaveBeenCalledWith('session.create', expect.anything()))

      if (destination === 'yolo') {
        gateway.release()
        await vi.waitFor(() => expect(gateway.requestGateway).toHaveBeenCalledWith('config.set', expect.anything()))
      }

      if (destination === 'fresh') {
        act(() => mounted.result.current.startFreshSessionDraft())
      } else {
        mounted.route.current = '/stored-other::'
        mounted.selectedStoredSessionIdRef.current = 'stored-other'
      }

      mounted.navigate.mockClear()
      await act(async () => {
        gateway.release()
        gateway.releaseYolo()
        expect(await sending).toBe(true)
      })
      const submits = gateway.requestGateway.mock.calls.filter(([method]) => method === 'prompt.submit')
      expect(submits).toHaveLength(1)
      expect(submits[0][1]).toMatchObject({ session_id: RUNTIME, text: '第一条' })
      expect(mounted.selectedStoredSessionIdRef.current).toBe(destination === 'fresh' ? null : 'stored-other')
      expect(navigatedToCreated(mounted.navigate)).toBe(false)
      expect(takeDetachedCreate(RUNTIME)).toBeNull()
    }
  )

  it('创建期间切到已有会话，原会话继续创建且不抢回页面', async () => {
    const gateway = deferredCreate()
    const mounted = mountActions(gateway.requestGateway)
    const created = mounted.result.current.createBackendSessionForSend('第一条')
    await vi.waitFor(() => expect(gateway.requestGateway).toHaveBeenCalledWith('session.create', expect.anything()))
    mounted.route.current = '/stored-other::'
    mounted.selectedStoredSessionIdRef.current = 'stored-other'
    await act(async () => {
      gateway.release()
      expect(await created).toBe(RUNTIME)
    })
    expect(takeDetachedCreate(RUNTIME)).toBe(STORED)
    expect(navigatedToCreated(mounted.navigate)).toBe(false)
    expect(mounted.selectedStoredSessionIdRef.current).toBe('stored-other')
    expect(gateway.requestGateway).not.toHaveBeenCalledWith('session.close', expect.anything())
  })

  it('建好的会话转后台：不跳页面、不改选中，侧栏有它，返回 runtime id 并登记 stored id', async () => {
    const { navigate, requestGateway, runtimeId, updateSessionState } = await sendThenMaybeOpenNewChat(true)

    expect(runtimeId).toBe(RUNTIME)
    expect(takeDetachedCreate(RUNTIME)).toBe(STORED)
    expect(navigatedToCreated(navigate)).toBe(false)
    expect($activeSessionId.get()).toBeNull()
    expect($selectedStoredSessionId.get()).toBeNull()
    expect($freshDraftReady.get()).toBe(true)
    expect($sessions.get().some(session => session.id === STORED)).toBe(true)
    expect(updateSessionState).toHaveBeenCalledWith(RUNTIME, expect.any(Function), STORED)
    expect(requestGateway).not.toHaveBeenCalledWith('session.close', expect.anything())
  })

  it('没开新对话时照旧切到建好的会话', async () => {
    const { navigate, runtimeId } = await sendThenMaybeOpenNewChat(false)

    expect(runtimeId).toBe(RUNTIME)
    expect(takeDetachedCreate(RUNTIME)).toBeNull()
    expect(navigatedToCreated(navigate)).toBe(true)
    expect($selectedStoredSessionId.get()).toBe(STORED)
  })

  it('新手引导这类带参数的创建留在前台', async () => {
    const { navigate } = await sendThenMaybeOpenNewChat(true, [null, undefined, { title: '欢迎' }])

    expect(takeDetachedCreate(RUNTIME)).toBeNull()
    expect(navigatedToCreated(navigate)).toBe(true)
  })

  it('创建途中换了 Profile 时停止创建，不把旧会话发布到新页面', async () => {
    const gateway = deferredCreate()
    const { navigate, result } = mountActions(gateway.requestGateway)
    let created: Promise<null | string> = Promise.resolve(null)

    await act(async () => {
      created = result.current.createBackendSessionForSend('第一条')
      await Promise.resolve()
    })
    act(() => {
      $activeGatewayProfile.set('work')
      $newChatProfile.set('work')
      result.current.startFreshSessionDraft()
    })
    await act(async () => {
      gateway.release()
      expect(await created).toBeNull()
    })

    expect(takeDetachedCreate(RUNTIME)).toBeNull()
    expect(navigatedToCreated(navigate)).toBe(false)
    expect(gateway.requestGateway).toHaveBeenCalledWith('session.close', { session_id: RUNTIME })
  })

  it('发送时开着 YOLO：套到转后台的会话上，不看当前新对话的开关', async () => {
    setYoloActive(true)
    const { requestGateway } = await sendThenMaybeOpenNewChat(true)

    expect(requestGateway).toHaveBeenCalledWith('config.set', { key: 'yolo', session_id: RUNTIME, value: '1' })
  })

  it('发送时没开 YOLO：之后在新对话里打开也不套到转后台的会话上', async () => {
    const gateway = deferredCreate()
    const { result } = mountActions(gateway.requestGateway)
    let created: Promise<null | string> = Promise.resolve(null)

    await act(async () => {
      created = result.current.createBackendSessionForSend('第一条')
      await Promise.resolve()
    })
    act(() => {
      result.current.startFreshSessionDraft()
      setYoloActive(true)
    })
    await act(async () => {
      gateway.release()
      await created
    })

    expect(gateway.requestGateway).not.toHaveBeenCalledWith('config.set', expect.objectContaining({ key: 'yolo' }))
  })
})
