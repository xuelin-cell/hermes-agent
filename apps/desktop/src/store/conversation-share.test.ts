import { beforeEach, describe, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({ owner: undefined as string | undefined }))

vi.mock('@/app/session/hooks/use-session-actions/utils', () => ({
  resolveSessionOwner: vi.fn(async () => probe.owner)
}))

vi.mock('./session-states', () => ({
  // 侧栏分页之外、从搜索打开的会话：同步线索全部缺失。
  knownOwnerForSession: () => undefined,
  storedSessionIdForRuntimeId: () => null
}))

vi.mock('./connection-registry-state', () => ({ hasRegistryTopology: () => true }))

vi.mock('./notifications', () => ({ logErrorToDesktopLog: vi.fn(), notify: vi.fn(), notifyError: vi.fn() }))

import { resolveSessionOwner } from '@/app/session/hooks/use-session-actions/utils'

import { $conversationShareTarget, notifyConversationShareError, openConversationShare } from './conversation-share'
import { notify, notifyError } from './notifications'

describe('会话分享的归属解析', () => {
  beforeEach(() => {
    $conversationShareTarget.set(null)
    vi.mocked(resolveSessionOwner).mockClear()
  })

  it('同步线索缺失时跨 profile 探测，按探测到的 profile 打开分享', async () => {
    probe.owner = 'equity-research'

    await openConversationShare('older-session', 7)

    expect(resolveSessionOwner).toHaveBeenCalledWith('older-session')
    expect($conversationShareTarget.get()).toEqual({
      owner: { profile: 'equity-research' },
      request: { sessionId: 'older-session', scope: 'response', responseRowId: 7 }
    })
  })

  it('探测也找不到归属时拒绝打开，不猜测当前活动 profile', async () => {
    probe.owner = undefined

    await expect(openConversationShare('unknown-session')).rejects.toThrow(/owner could not be resolved/)
    expect($conversationShareTarget.get()).toBeNull()
  })
})

describe('分享入口的失败提示', () => {
  const copy = { unavailable: '无法打开分享', ownerUnknown: '无法确认该会话所属的配置，请先打开该会话后重试。' }

  it('归属无法确认时提示可操作的说明，而不是底层英文报错', async () => {
    probe.owner = undefined
    const error = await openConversationShare('unknown-session').catch((failure: unknown) => failure)

    notifyConversationShareError(error, copy)

    expect(notify).toHaveBeenCalledWith({ kind: 'error', title: copy.unavailable, message: copy.ownerUnknown })
    expect(notifyError).not.toHaveBeenCalled()
  })
})
