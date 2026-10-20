import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createClientSessionState } from '@/lib/chat-runtime'
import { $activeGatewayProfile, $newChatConnectionId, $newChatProfile, $newChatRoute } from '@/store/profile'
import { $projectScope, ALL_PROJECTS } from '@/store/project-scope'
import {
  _resetSessionOwnerHintsForTests,
  setActiveSessionId,
  setConnection,
  setCurrentCwdExplicit,
  setCurrentCwdTransient,
  setNewChatWorkspaceTarget,
  setSessions
} from '@/store/session'

import { useSessionActions } from './use-session-actions'

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

const WORKSPACE = 'C:\\uniworker\\acc\\workspace'
const FOLDER = `${WORKSPACE}\\20261019-103015`

const bridge = {
  createConversationFolder: vi.fn(async (_defaultCwd: string): Promise<null | string> => FOLDER),
  discardConversationFolder: vi.fn(async (_folder: string) => undefined)
}

let defaultCwd = WORKSPACE
let createFails = false

/** 只模拟后端两个请求：按档案查默认目录，以及创建会话。 */
function gatewayReply(method: string, params?: Record<string, unknown>) {
  if (method === 'config.get' && params?.key === 'project') {
    return { cwd: defaultCwd }
  }

  if (method === 'session.create') {
    if (createFails) {
      throw new Error('create failed')
    }

    return { session_id: 'created', stored_session_id: 'created-stored', info: {} }
  }

  return {}
}

/** 挂载会话操作，ambient 请求走本地网关模拟。 */
function mountActions() {
  const ref = <T,>(current: T) => ({ current })

  const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => gatewayReply(method, params))

  const state = createClientSessionState()

  const result = renderHook(() =>
    useSessionActions({
      activeSessionId: null,
      activeSessionIdRef: ref<string | null>(null),
      busyRef: ref(false),
      creatingSessionRef: ref(false),
      ensureSessionState: () => state,
      getRouteToken: () => 'route',
      getRoutedStoredSessionId: () => null,
      navigate: vi.fn(),
      requestGateway: requestGateway as never,
      resetViewSync: vi.fn(),
      runtimeIdByStoredSessionIdRef: ref(new Map()),
      selectedStoredSessionId: null,
      selectedStoredSessionIdRef: ref<string | null>(null),
      sessionStateByRuntimeIdRef: ref(new Map()),
      syncSessionStateToView: vi.fn(),
      updateSessionState: () => state
    })
  )

  return { ...result, requestGateway }
}

/** 取最后一次 `session.create` 的参数。 */
function createParams(requestGateway: ReturnType<typeof mountActions>['requestGateway']) {
  const call = requestGateway.mock.calls.filter(([method]) => method === 'session.create').at(-1)

  return call?.[1] as Record<string, unknown>
}

beforeEach(() => {
  _resetSessionOwnerHintsForTests()
  $newChatRoute.set(null)
  $newChatProfile.set('default')
  $newChatConnectionId.set(null)
  $activeGatewayProfile.set('default')
  $projectScope.set(ALL_PROJECTS)
  setSessions([])
  setActiveSessionId(null)
  setNewChatWorkspaceTarget(undefined)
  setCurrentCwdTransient('')
  setCurrentCwdExplicit(false)
  setConnection({ mode: 'local' } as never)
  defaultCwd = WORKSPACE
  createFails = false
  bridge.createConversationFolder.mockClear().mockResolvedValue(FOLDER)
  bridge.discardConversationFolder.mockClear()
  window.hermesDesktop = { ...bridge } as never
})

afterEach(() => {
  cleanup()
  setConnection(null)
  setNewChatWorkspaceTarget(undefined)
  setCurrentCwdExplicit(false)
  setCurrentCwdTransient('')
  setSessions([])
  window.hermesDesktop = undefined as never
  vi.clearAllMocks()
})

describe('未选目录的新对话使用专属文件夹', () => {
  it('普通发送：按档案查默认目录，建好后以“用户选定”发给后端', async () => {
    const { result, requestGateway } = mountActions()

    await act(() => result.current.createBackendSessionForSend('你好'))

    expect(requestGateway).toHaveBeenCalledWith('config.get', { key: 'project', profile: 'default' })
    expect(bridge.createConversationFolder).toHaveBeenCalledWith(WORKSPACE)
    expect(createParams(requestGateway)).toMatchObject({ cwd: FOLDER, cwd_explicit: true })
  })

  it('当前目录就是默认工作区（未主动选）时同样建', async () => {
    setCurrentCwdTransient('c:/uniworker/acc/workspace/')
    const { result, requestGateway } = mountActions()

    await act(() => result.current.createBackendSessionForSend('你好'))

    expect(createParams(requestGateway)).toMatchObject({ cwd: FOLDER, cwd_explicit: true })
  })

  it('选回“默认工作区”后照常建', async () => {
    setNewChatWorkspaceTarget(null)
    const { result, requestGateway } = mountActions()

    await act(() => result.current.createBackendSessionForSend('你好'))

    expect(createParams(requestGateway)).toMatchObject({ cwd: FOLDER, cwd_explicit: true })
  })

  it('用户主动选了目录时不建，目录原样发送', async () => {
    setNewChatWorkspaceTarget('D:\\项目')
    setCurrentCwdExplicit(true)
    const { result, requestGateway } = mountActions()

    await act(() => result.current.createBackendSessionForSend('你好'))

    expect(bridge.createConversationFolder).not.toHaveBeenCalled()
    expect(createParams(requestGateway)).toMatchObject({ cwd: 'D:\\项目', cwd_explicit: true })
  })

  it('用户主动选的正是工作区本身时也不建', async () => {
    setNewChatWorkspaceTarget(WORKSPACE)
    setCurrentCwdExplicit(true)
    const { result, requestGateway } = mountActions()

    await act(() => result.current.createBackendSessionForSend('你好'))

    expect(bridge.createConversationFolder).not.toHaveBeenCalled()
    expect(createParams(requestGateway)).toMatchObject({ cwd: WORKSPACE, cwd_explicit: true })
  })

  it('当前目录不是默认工作区（例如项目目录）时不建', async () => {
    setCurrentCwdTransient('D:\\repo')
    const { result, requestGateway } = mountActions()

    await act(() => result.current.createBackendSessionForSend('你好'))

    expect(bridge.createConversationFolder).not.toHaveBeenCalled()
    expect(createParams(requestGateway)).toMatchObject({ cwd: 'D:\\repo', cwd_explicit: false })
  })

  it('主进程拒绝（专家自带目录）时保持原参数', async () => {
    defaultCwd = 'D:\\expert'
    bridge.createConversationFolder.mockResolvedValue(null)
    const { result, requestGateway } = mountActions()

    await act(() => result.current.createBackendSessionForSend('你好'))

    expect(bridge.createConversationFolder).toHaveBeenCalledWith('D:\\expert')
    expect(createParams(requestGateway)).not.toHaveProperty('cwd')
    expect(createParams(requestGateway)).not.toHaveProperty('cwd_explicit')
  })

  it.each([
    ['没有主进程接口', () => (window.hermesDesktop = {} as never)],
    ['远程连接', () => setConnection({ mode: 'remote' } as never)]
  ])('%s时不查默认目录也不建', async (_name, arrange) => {
    arrange()
    const { result, requestGateway } = mountActions()

    await act(() => result.current.createBackendSessionForSend('你好'))

    expect(requestGateway).not.toHaveBeenCalledWith('config.get', expect.anything())
    expect(bridge.createConversationFolder).not.toHaveBeenCalled()
    expect(createParams(requestGateway)).not.toHaveProperty('cwd')
  })

  it('新手引导对话不建', async () => {
    const { result } = mountActions()

    await act(() => result.current.createBackendSessionForSend(null, undefined, { title: '欢迎' }))
    await act(() => result.current.createBackendSessionForSend(null, [{ content: 'hi', role: 'assistant' }]))

    expect(bridge.createConversationFolder).not.toHaveBeenCalled()
  })

  it('创建会话失败时请主进程删掉刚建的文件夹', async () => {
    createFails = true
    const { result } = mountActions()

    await act(async () => {
      await expect(result.current.createBackendSessionForSend('你好')).rejects.toThrow('create failed')
    })

    expect(bridge.discardConversationFolder).toHaveBeenCalledWith(FOLDER)
  })

  it('分屏新开的普通对话建，Bot 标签不建', async () => {
    const { result, requestGateway } = mountActions()

    await act(() => result.current.openNewSessionTile('right'))

    expect(createParams(requestGateway)).toMatchObject({ cwd: FOLDER, cwd_explicit: true })

    bridge.createConversationFolder.mockClear()
    await act(() => result.current.openNewSessionTile('right', { workspaceScope: { workspaceMode: 'bots' } as never }))

    expect(bridge.createConversationFolder).not.toHaveBeenCalled()
    expect(createParams(requestGateway)).toMatchObject({ hidden: true })
    expect(createParams(requestGateway)).not.toHaveProperty('cwd_explicit', true)
  })
})
