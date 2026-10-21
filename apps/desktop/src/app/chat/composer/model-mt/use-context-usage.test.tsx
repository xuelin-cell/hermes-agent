import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import type { PropsWithChildren } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { PRIMARY_SESSION_VIEW, SessionViewProvider } from '@/app/chat/session-view'
import type { HermesGateway } from '@/hermes'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $currentUsage } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import type { ContextBreakdown } from '@/types/hermes'

import { useComposerModelMeta } from './model-meta'
import { useComposerContextUsage } from './use-context-usage'

vi.mock('./model-meta', () => ({ useComposerModelMeta: vi.fn() }))

afterEach(() => {
  cleanup()
  $sessionStates.set({})
  $currentUsage.set({ calls: 0, input: 0, output: 0, total: 0 })
})

it('换模型立即重算并丢弃迟到明细，换会话后不串用旧明细', async () => {
  const model = atom('a')
  const provider = atom('custom:p')
  const pending: Array<(value: ContextBreakdown) => void> = []
  const request = vi.fn(() => new Promise<ContextBreakdown>(resolve => pending.push(resolve)))
  const gateway = { request } as unknown as HermesGateway
  vi.mocked(useComposerModelMeta).mockReturnValue({
    rows: [],
    loading: false,
    error: false,
    find: (_provider, name) => ({ contextWindow: name === 'a' ? 100000 : 300000 }) as never
  })
  $currentUsage.set({ calls: 0, input: 0, output: 0, total: 0, context_used: 30000 })

  /** 注入可切换的主窗格模型，实际订阅用量和 RPC 生命周期。 */
  function wrapper({ children }: PropsWithChildren) {
    return (
      <SessionViewProvider value={{ ...PRIMARY_SESSION_VIEW, $model: model, $provider: provider }}>
        {children}
      </SessionViewProvider>
    )
  }

  const { result, rerender } = renderHook(
    ({ sessionId }) => useComposerContextUsage({ busy: false, gateway, sessionId }),
    { wrapper, initialProps: { sessionId: 'first' } }
  )

  expect(result.current.context?.percent).toBe(30)
  act(() => model.set('b'))
  expect(result.current.context?.percent).toBe(10)
  await act(async () => {
    pending[0]({ context_used: 99000 } as ContextBreakdown)
  })
  expect(result.current.breakdown).toBeNull()
  await act(async () => {
    pending[1]({ context_used: 60000, context_max: 100000 } as ContextBreakdown)
  })
  expect(result.current.usage).toMatchObject({ context_used: 60000, context_max: 300000, context_percent: 20 })
  rerender({ sessionId: 'second' })
  expect(result.current.breakdown).toBeNull()
  expect(request).toHaveBeenLastCalledWith('session.context_breakdown', { session_id: 'second' })
})

it('并排窗格读取自己的用量，忙碌时不查询，空白对话归零', async () => {
  const request = vi.fn().mockRejectedValue(new Error('offline'))
  const gateway = { request } as unknown as HermesGateway
  vi.mocked(useComposerModelMeta).mockReturnValue({ rows: [], loading: false, error: false, find: () => undefined })
  $currentUsage.set({ calls: 0, input: 0, output: 0, total: 0, context_used: 99999, context_max: 100000 })
  $sessionStates.set({
    tile: {
      ...createClientSessionState(),
      usage: { calls: 1, input: 0, output: 0, total: 0, context_used: 200, context_max: 1000 }
    }
  })

  /** 使用真实窗格状态，避免主会话全局镜像污染并排用量。 */
  function wrapper({ children }: PropsWithChildren) {
    return <SessionViewProvider value={{ ...PRIMARY_SESSION_VIEW, kind: 'tile' }}>{children}</SessionViewProvider>
  }

  const { result, rerender } = renderHook(({ busy }) => useComposerContextUsage({ busy, gateway, sessionId: 'tile' }), {
    wrapper,
    initialProps: { busy: true }
  })

  expect(result.current.context).toMatchObject({ used: 200, percent: 20 })
  expect(request).not.toHaveBeenCalled()
  rerender({ busy: false })
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.context?.used).toBe(200)
  const draft = renderHook(() => useComposerContextUsage({ busy: false, gateway, sessionId: null }))
  expect(draft.result.current.context?.used).toBe(0)
})
