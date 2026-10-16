import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $apiRequestScope } from '@/api/client'
import { $connection } from '@/store/session'

import { useLocalArtifacts } from './use-local-artifacts'

const backend = vi.hoisted(() => ({ list: vi.fn(), messages: vi.fn() }))
vi.mock('@/hermes', () => ({ listAllProfileSessions: backend.list, getAllSessionMessages: backend.messages }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  $connection.set(null)
})

it('Profile A→B→A 的迟到扫描不串目录，再入页面同步展示缓存后后台刷新', async () => {
  $connection.set({ mode: 'local', profile: 'a' } as never)
  $apiRequestScope.set({ connectionId: 'local', profile: 'a' })
  vi.stubGlobal('hermesDesktop', {
    normalizePreviewTarget: vi.fn(async (value: string) => ({ path: value, byteSize: 3 }))
  })
  backend.list.mockImplementation(async () => ({
    sessions: [
      {
        id: 'same-id',
        profile: $apiRequestScope.get().profile,
        connection_id: 'local',
        cwd: '/',
        last_active: 1,
        message_count: 1
      }
    ]
  }))

  /** 延迟完成旧上下文请求，验证其不能覆盖新来源。 */
  let finishOld: (value: unknown) => void = () => {}
  backend.messages.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishOld = resolve
      })
  )
  backend.messages.mockImplementation(async (_id, owner) => ({
    messages: [{ role: 'assistant', content: `MEDIA:/${owner.profile}.md` }]
  }))
  let view = renderHook(useLocalArtifacts)
  await waitFor(() => expect(backend.messages).toHaveBeenCalledTimes(1))
  act(() => $apiRequestScope.set({ connectionId: 'local', profile: 'b' }))
  await waitFor(() => expect(view.result.current.groups[0]?.files[0]?.label).toBe('b.md'))
  await act(async () => finishOld({ messages: [{ role: 'assistant', content: 'MEDIA:/old-a.md' }] }))
  expect(view.result.current.groups[0]?.files[0]?.label).toBe('b.md')
  act(() => $apiRequestScope.set({ connectionId: 'local', profile: 'a' }))
  await waitFor(() => expect(view.result.current.groups[0]?.files[0]?.label).toBe('a.md'))
  view.unmount()
  backend.list.mockReturnValueOnce(new Promise(() => {}))
  view = renderHook(useLocalArtifacts)
  expect(view.result.current.groups[0]?.files[0]?.label).toBe('a.md')
  expect(view.result.current.scanning).toBe(true)
  expect(backend.messages).toHaveBeenCalledTimes(3)
})
