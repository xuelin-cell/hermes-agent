import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { getCurrentModelSource, setCurrentModelSource } from '@/store/session'

import { useResetComposerModelOnNewChat } from './new-chat-model'

afterEach(() => {
  cleanup()
  setCurrentModelSource('')
})

it('从会话进入已就绪的新对话时恢复默认，进入会话不重置', () => {
  setCurrentModelSource('manual')

  const { rerender } = renderHook(({ id, ready }) => useResetComposerModelOnNewChat(id, ready), {
    initialProps: { id: 'old' as string | null, ready: false }
  })

  expect(getCurrentModelSource()).toBe('manual')
  rerender({ id: null, ready: false })
  expect(getCurrentModelSource()).toBe('manual')
  rerender({ id: null, ready: true })
  expect(getCurrentModelSource()).toBe('default')
})

it('空白启动恢复默认，但草稿内手选后重渲染或断线重连都保留选择', () => {
  setCurrentModelSource('manual')

  const { rerender } = renderHook(({ ready }) => useResetComposerModelOnNewChat(null, ready), {
    initialProps: { ready: true }
  })

  expect(getCurrentModelSource()).toBe('default')
  act(() => setCurrentModelSource('manual'))
  rerender({ ready: true })
  expect(getCurrentModelSource()).toBe('manual')
  rerender({ ready: false })
  rerender({ ready: true })
  expect(getCurrentModelSource()).toBe('manual')
})
