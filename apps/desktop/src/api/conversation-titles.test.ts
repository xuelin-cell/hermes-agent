import { afterEach, expect, it, vi } from 'vitest'

import { hermesApi } from './client'
import { refreshConversationTitle, seedConversationTitle } from './conversation-titles'
import { getSession } from './sessions'
vi.mock('./sessions', () => ({ getSession: vi.fn() }))
vi.mock('./client', () => ({ hermesApi: vi.fn() }))
afterEach(() => vi.clearAllMocks())

it('临时与正式事件重叠时追加一次权威读取，不并行采用旧结果', async () => {
  let resolve!: (value: unknown) => void
  vi.mocked(getSession)
    .mockImplementationOnce(
      () =>
        new Promise(r => {
          resolve = r
        }) as never
    )
    .mockResolvedValueOnce({ id: 'stored', title: '正式标题' } as never)
  const applied: string[] = []
  const owner = { profile: 'project-a', connectionId: 'local' }
  const first = refreshConversationTitle(owner, 'stored', row => applied.push(row.title!))
  await Promise.resolve()
  const second = refreshConversationTitle(owner, 'stored', row => applied.push(row.title!))
  expect(getSession).toHaveBeenCalledTimes(1)
  resolve({ id: 'stored', title: '临时标题' })
  await Promise.all([first, second])
  expect(applied).toEqual(['临时标题', '正式标题'])
  expect(getSession).toHaveBeenCalledTimes(2)
})
it('标题元数据固定传给原会话Profile；非受管远端不调用本地数字员工资源', async () => {
  vi.mocked(hermesApi).mockResolvedValue({ ok: true })
  await seedConversationTitle({ profile: 'project-a', connectionId: 'local' }, 'stored', '图片.png', '')
  expect(hermesApi).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionId: 'local',
      profile: 'project-a',
      body: { sessionId: 'stored', temporary: '图片.png', intent: '' }
    })
  )
  await seedConversationTitle({ profile: 'project-a', connectionId: 'remote' }, 'stored', '图片.png', '')
  expect(hermesApi).toHaveBeenCalledTimes(1)
})
