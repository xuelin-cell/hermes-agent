import { beforeEach, expect, it, vi } from 'vitest'

import { refreshConversationTitle } from '@/api/conversation-titles'
import { $sessions, setSessions } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { handleSessionInfoEvent } from './session-info'
import type { GatewayEventContext } from './types'

vi.mock('@/api/conversation-titles', () => ({ refreshConversationTitle: vi.fn() }))

/** 构造后台标题事件，正文与前台导航不参与标题刷新。 */
function event(connectionId = 'local'): GatewayEventContext {
  return {
    deps: {},
    event: {
      type: 'plugin.uniwork-titles.changed', connectionId, profile: 'default',
      payload: { session_id: 'stored', profile: 'b', title: '过时的自动结果' }
    },
    fromActiveSource: () => false
  } as unknown as GatewayEventContext
}

beforeEach(() => {
  vi.clearAllMocks()
  setSessions(['a', 'b'].map(profile => ({ id: 'stored', profile, title: '临时标题' }) as SessionInfo))
})

it('使用持久会话的权威重读更新后台Profile，不采用事件中的迟到标题', async () => {
  vi.mocked(refreshConversationTitle).mockImplementation(async (_owner, id, apply) => {
    apply({ id, profile: 'b', title: '用户已手动改名' } as SessionInfo)
  })
  expect(handleSessionInfoEvent(event())).toBe(true)
  await Promise.resolve()
  expect(refreshConversationTitle).toHaveBeenCalledWith(
    { connectionId: 'local', profile: 'b' }, 'stored', expect.any(Function)
  )
  expect($sessions.get().map(row => row.title)).toEqual(['临时标题', '用户已手动改名'])
})

it('标题读取失败时保留已显示名称，不使消息事件处理失败', async () => {
  vi.mocked(refreshConversationTitle).mockRejectedValue(new Error('offline'))
  expect(handleSessionInfoEvent(event())).toBe(true)
  await Promise.resolve()
  expect($sessions.get().map(row => row.title)).toEqual(['临时标题', '临时标题'])
})

it('远端插件事件不能触发本地标题读取或修改同ID会话', () => {
  expect(handleSessionInfoEvent(event('remote'))).toBe(true)
  expect(refreshConversationTitle).not.toHaveBeenCalled()
  expect($sessions.get().map(row => row.title)).toEqual(['临时标题', '临时标题'])
})
