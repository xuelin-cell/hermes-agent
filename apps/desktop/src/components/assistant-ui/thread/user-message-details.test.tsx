import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { toChatMessages } from '@/lib/chat-messages'
import { toRuntimeMessage } from '@/lib/chat-runtime'
import type { SessionMessage } from '@/types/hermes'

import { stubThreadEnvironment, ThreadRuntime } from '../test-utils'

import { Thread } from '.'

vi.mock('@/hooks/use-resize-observer', async () => {
  const { useEffect } = await import('react')

  return {
    useResizeObserver: (handler: (entries: unknown[]) => void, ref: { current: HTMLElement | null }) => {
      useEffect(() => {
        if (ref.current) {
          handler([{ target: ref.current, borderBoxSize: [{ blockSize: 300 }] }])
        }
      }, [handler, ref])
    }
  }
})

beforeEach(stubThreadEnvironment)
afterEach(cleanup)

it('expands and collapses long prompts without opening the editor', () => {
  const messages = toChatMessages([
    { role: 'user', content: 'A long question with all its original details', timestamp: 1 }
  ] as SessionMessage[]).map(toRuntimeMessage)
  const { container } = render(
    <ThreadRuntime messages={messages}>
      <Thread />
    </ThreadRuntime>
  )
  const toggle = within(container).getByRole('button', { name: 'View details' })
  const content = container.querySelector('.sticky-human-clamp')!
  expect(content).not.toBeNull()
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(container.querySelector('.sticky-human-clamp')).toBeNull()
  expect(container.querySelector('[contenteditable="true"]')).toBeNull()
  fireEvent.click(within(container).getByRole('button', { name: 'Collapse' }))
  expect(container.querySelector('.sticky-human-clamp')).not.toBeNull()
})
