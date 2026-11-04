import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { en } from '@/i18n/en'
import { toChatMessages } from '@/lib/chat-messages'
import { toRuntimeMessage } from '@/lib/chat-runtime'
import { formatFooterTime } from '@/lib/message-time'
import { formatTurnTokenCount } from '@/lib/turn-token-usage'

import { stubThreadEnvironment, ThreadRuntime } from '../test-utils'

import { Thread } from '.'

stubThreadEnvironment()
afterEach(cleanup)

it('shows persisted turn tokens beside the existing actions and hides absent usage on older replies', async () => {
  const usage = {
    input_tokens: 1200,
    output_tokens: 80,
    total_tokens: 1280,
    cache_read_tokens: 400,
    cache_write_tokens: 0
  }

  const messages = toChatMessages([
    { role: 'user', content: 'question', timestamp: 1 },
    {
      role: 'assistant',
      content: 'done',
      timestamp: 2,
      display_metadata: {
        turn_completed_at: 2.75,
        turn_token_usage: usage,
        turn_model: { model: 'raw-response-model', provider: 'custom:endpoint', name: 'Custom Reply Model' }
      }
    }
  ]).map(toRuntimeMessage)

  const { container, unmount } = render(
    <ThreadRuntime messages={messages}>
      <Thread />
    </ThreadRuntime>
  )

  await screen.findByText('done')
  const badge = container.querySelector('[data-slot="aui_turn-token-usage"]')!
  expect(badge.querySelector('[data-slot="aui_turn-token-count"]')?.textContent).toBe('1.28K')
  expect(badge.textContent).toBe('1.28Ktokens')
  expect(badge.getAttribute('aria-label')).toBe(en.assistant.thread.turnTokenUsage('1,200', '80', '1,280'))
  const actions = badge.closest('[data-slot="aui_assistant-footer"]')?.querySelector('[data-slot="aui_msg-actions"]')
  expect(actions).not.toBeNull()
  expect(actions!.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const modelName = await screen.findByText('Custom Reply Model')
  expect(modelName.getAttribute('data-slot')).toBe('aui_reply-model')
  const completed = container.querySelector('[data-slot="aui_reply-completed"] time')!
  expect(completed.getAttribute('datetime')).toBe(new Date(2750).toISOString())
  expect(completed.textContent).toBe(formatFooterTime(2.75, 'en', 'Yesterday'))
  const sent = container.querySelector('[data-slot="aui_user-sent-time"]')!
  expect(sent.getAttribute('datetime')).toBe(new Date(1000).toISOString())
  expect(sent.textContent).toBe(formatFooterTime(1, 'en', 'Yesterday'))
  expect(badge.compareDocumentPosition(modelName) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(await screen.findByRole('button', { name: 'Copy' })).toBeTruthy()
  unmount()
  const older = toChatMessages([{ role: 'assistant', content: 'older reply', timestamp: 100 }]).map(toRuntimeMessage)

  const { container: olderContainer, unmount: unmountOlder } = render(
    <ThreadRuntime messages={older}>
      <Thread />
    </ThreadRuntime>
  )

  await screen.findByText('older reply')
  expect(olderContainer.querySelector('[data-slot="aui_turn-token-usage"]')).toBeNull()
  expect(olderContainer.querySelector('[data-slot="aui_reply-model"]')).toBeNull()
  expect(olderContainer.querySelector('[data-slot="aui_reply-completed"]')).toBeNull()
  unmountOlder()

  const modelOnly = toChatMessages([
    {
      role: 'assistant',
      content: 'reply without usage',
      display_metadata: { turn_model: { model: 'deepseek-v4-flash' } }
    }
  ]).map(toRuntimeMessage)

  const { container: modelOnlyContainer } = render(
    <ThreadRuntime messages={modelOnly}>
      <Thread />
    </ThreadRuntime>
  )

  expect(await screen.findByText('DeepSeek V4 Flash')).toBeTruthy()
  expect(modelOnlyContainer.querySelector('[data-slot="aui_turn-token-usage"]')).toBeNull()
})

it('uses the same K/M units and precision in Chinese and English', () => {
  for (const locale of ['en', 'zh', 'zh-hant']) {
    for (const [value, expected] of [
      [999, '999'],
      [1000, '1K'],
      [12800, '12.8K'],
      [413140, '413.14K'],
      [1000000, '1M'],
      [1234567, '1.23M']
    ] as const) {
      expect(formatTurnTokenCount(value, locale)).toBe(expected)
    }
  }
})

it('keeps only the latest idle reply footer persistent and allows historical footers during a new turn', async () => {
  const messages = toChatMessages([
    { role: 'user', content: 'first question', timestamp: 1 },
    { role: 'assistant', content: 'first reply', timestamp: 2 },
    { role: 'user', content: 'second question', timestamp: 3 },
    { role: 'assistant', content: 'second reply', timestamp: 4 }
  ]).map(toRuntimeMessage)

  const { container, rerender } = render(
    <ThreadRuntime messages={messages}>
      <Thread />
    </ThreadRuntime>
  )

  await screen.findByText('second reply')
  const footers = container.querySelectorAll('[data-slot="aui_assistant-footer"]')
  expect(footers).toHaveLength(2)
  expect(footers[0].hasAttribute('data-always-visible')).toBe(false)
  expect(footers[1].hasAttribute('data-always-visible')).toBe(true)

  rerender(
    <ThreadRuntime isRunning messages={messages}>
      <Thread />
    </ThreadRuntime>
  )
  expect(footers[0].hasAttribute('inert')).toBe(false)
  await waitFor(() => expect(footers[1].hasAttribute('inert')).toBe(true))
  expect(footers[1].hasAttribute('data-always-visible')).toBe(false)

  rerender(
    <ThreadRuntime messages={messages}>
      <Thread />
    </ThreadRuntime>
  )
  await waitFor(() => expect(footers[1].hasAttribute('inert')).toBe(false))
  expect(footers[1].hasAttribute('data-always-visible')).toBe(true)
})
