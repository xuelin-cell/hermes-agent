import { act, cleanup, renderHook } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetDetachedCreateForTests, bumpFreshDraftEpoch, markDetachedCreate } from '@/app/session/detached-create-mt'
import { $notifications, clearNotifications } from '@/store/notifications'
import { $busy, setBusy, setSessions } from '@/store/session'

import { clearSingleFlightSessionResumeState } from './single-flight-resume'

import { usePromptActions } from '.'

vi.mock('@/hermes', () => ({
  getLatestSessionMessages: vi.fn(async () => ({ messages: [], session_id: 'session' })),
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  getSession: vi.fn(),
  PROMPT_SUBMIT_REQUEST_TIMEOUT_MS: 1_800_000,
  setApiRequestProfile: vi.fn(),
  transcribeAudio: vi.fn()
}))
vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestGatewayForAgent: vi.fn()
}))

type CreateSession = (preview?: null | string) => Promise<null | string>

interface Mounted {
  activeSessionIdRef: MutableRefObject<null | string>
  busyRef: MutableRefObject<boolean>
  requestGateway: ReturnType<typeof vi.fn>
  selectedStoredSessionIdRef: MutableRefObject<null | string>
  submitText: (text: string) => Promise<boolean>
  submitTextRaw: (text: string) => Promise<boolean>
  updates: { sessionId: string; storedSessionId: null | string | undefined; state: Record<string, unknown> }[]
}

/** 在新对话页（没有会话、没有选中）挂上发送逻辑。 */
function mountNewChat(createBackendSessionForSend: CreateSession, promptSubmit?: () => unknown): Mounted {
  const activeSessionIdRef: MutableRefObject<null | string> = { current: null }
  const selectedStoredSessionIdRef: MutableRefObject<null | string> = { current: null }
  const busyRef: MutableRefObject<boolean> = { current: false }
  const updates: Mounted['updates'] = []
  let state: Record<string, unknown> = { awaitingResponse: false, busy: false, messages: [], streamId: null }

  const requestGateway = vi.fn(async (method: string) => {
    if (method === 'prompt.submit') {
      return promptSubmit ? promptSubmit() : {}
    }

    return {}
  })

  const { result } = renderHook(() =>
    usePromptActions({
      activeSessionId: null,
      activeSessionIdRef,
      branchCurrentSession: async () => true,
      busyRef,
      createBackendSessionForSend,
      getRoutedStoredSessionId: () => null,
      getRuntimeIdForStoredSession: () => null,
      getRouteToken: () => '/::',
      handleSkinCommand: () => '',
      openMemoryGraph: () => undefined,
      refreshSessions: async () => undefined,
      requestGateway: requestGateway as never,
      resumeStoredSession: () => undefined,
      runtimeIdByStoredSessionIdRef: { current: new Map() },
      selectedStoredSessionIdRef,
      startFreshSessionDraft: () => undefined,
      sttEnabled: false,
      updateSessionState: (sessionId, updater, storedSessionId) => {
        state = updater(state as never) as unknown as Record<string, unknown>
        updates.push({ sessionId, state, storedSessionId })

        return state as never
      }
    })
  )

  return {
    activeSessionIdRef,
    busyRef,
    requestGateway,
    selectedStoredSessionIdRef,
    submitText: text => act(async () => result.current.submitText(text)) as Promise<boolean>,
    submitTextRaw: text => result.current.submitText(text),
    updates
  }
}

/** 模拟 createBackendSessionForSend 转后台：用户已开了新对话（busy 被重置），只登记、不切视图。 */
const detachedCreate = (runtimeId: string, storedId: string) =>
  vi.fn(async () => {
    setBusy(false)
    markDetachedCreate(runtimeId, storedId)

    return runtimeId
  })

const promptSubmits = (requestGateway: ReturnType<typeof vi.fn>) =>
  requestGateway.mock.calls.filter(([method]) => method === 'prompt.submit').map(([, params]) => params)

beforeEach(() => {
  _resetDetachedCreateForTests()
  clearSingleFlightSessionResumeState()
  clearNotifications()
  setSessions([])
  setBusy(false)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('新对话的会话转后台后照常发送（desktop-mt）', () => {
  it('第一条消息发到后台会话，状态带着它自己的 stored id，不动当前视图', async () => {
    const mounted = mountNewChat(detachedCreate('rt-a', 'stored-a'))

    expect(await mounted.submitText('第一条')).toBe(true)
    expect(promptSubmits(mounted.requestGateway)).toEqual([expect.objectContaining({ session_id: 'rt-a' })])
    expect(mounted.updates.filter(update => update.sessionId === 'rt-a').length).toBeGreaterThan(0)
    expect(mounted.updates.every(update => update.sessionId !== 'rt-a' || update.storedSessionId === 'stored-a')).toBe(
      true
    )
    expect(mounted.activeSessionIdRef.current).toBeNull()
    expect(mounted.selectedStoredSessionIdRef.current).toBeNull()
    expect($busy.get()).toBe(false)
  })

  it('后台会话发送失败：不退回输入框（返回 true），错误留在它自己的会话里并弹提示', async () => {
    const mounted = mountNewChat(detachedCreate('rt-a', 'stored-a'), () => {
      throw new Error('gateway exploded')
    })

    expect(await mounted.submitText('第一条')).toBe(true)

    const last = mounted.updates.at(-1)

    expect(last?.sessionId).toBe('rt-a')
    expect(last?.storedSessionId).toBe('stored-a')
    expect((last?.state.messages as { error?: string }[]).some(message => message.error)).toBe(true)
    expect($notifications.get().length).toBeGreaterThan(0)
  })

  it('第一个还在建会话时，第二个新对话也能立刻发送', async () => {
    let releaseFirst: () => void = () => undefined
    const firstPending = new Promise<void>(done => (releaseFirst = done))
    let mounted: Mounted | null = null

    const create = vi
      .fn<CreateSession>()
      .mockImplementationOnce(async () => {
        await firstPending
        markDetachedCreate('rt-a', 'stored-a')

        return 'rt-a'
      })
      .mockImplementationOnce(async () => {
        mounted!.activeSessionIdRef.current = 'rt-b'
        mounted!.selectedStoredSessionIdRef.current = 'stored-b'

        return 'rt-b'
      })

    mounted = mountNewChat(create)
    // 第一条停在建会话那一步；用户随即开了新对话。
    const first = mounted.submitTextRaw('第一条')
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    // 和 startFreshSessionDraft 一样：记一次新对话，并把前台的发送状态清掉。
    bumpFreshDraftEpoch()
    mounted.busyRef.current = false
    setBusy(false)

    expect(await mounted.submitText('第二个新对话的第一条')).toBe(true)

    releaseFirst()

    expect(await act(async () => first)).toBe(true)
    expect(promptSubmits(mounted.requestGateway).map(params => (params as { session_id: string }).session_id)).toEqual([
      'rt-b',
      'rt-a'
    ])
  })
})
