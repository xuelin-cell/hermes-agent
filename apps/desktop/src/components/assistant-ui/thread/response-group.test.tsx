import type { ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { toChatMessages } from '@/lib/chat-messages'
import { toRuntimeMessage } from '@/lib/chat-runtime'
import type { SessionMessage } from '@/types/hermes'

import { stubThreadEnvironment, ThreadRuntime } from '../test-utils'

import { Thread } from '.'

beforeEach(stubThreadEnvironment)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('keeps background continuations in one response with one action bar and the original message identities', async () => {
  const content = '[IMPORTANT: Background process proc_example completed normally (exit code 0).\nOutput:\nVerified.]'
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal('navigator', { ...navigator, clipboard })
  const branch = vi.fn()

  for (const display of [
    {},
    { display_kind: 'process_complete', display_metadata: { display_text: 'Background Process Finished: verify' } },
    { display_kind: 'async_delegation_complete', display_metadata: { display_text: 'Background agent finished' } }
  ]) {
    const stored = [
      { role: 'user', content: 'Verify it.', timestamp: 1 },
      { role: 'assistant', content: 'Checking the deployment.', timestamp: 2 },
      { role: 'user', content, timestamp: 3, ...display },
      { role: 'assistant', content: 'The deployment is verified.', timestamp: 4 }
    ] as SessionMessage[]

    const messages = toChatMessages(stored).map(toRuntimeMessage)

    const { container, rerender, unmount } = render(
      <ThreadRuntime messages={messages.slice(0, 2)}>
        <Thread onBranchInNewChat={branch} />
      </ThreadRuntime>
    )

    const original = container.querySelector('[data-role="assistant"]')

    rerender(
      <ThreadRuntime messages={messages}>
        <Thread onBranchInNewChat={branch} />
      </ThreadRuntime>
    )
    await waitFor(() => expect(container.textContent).toContain('The deployment is verified.'))
    expect(container.querySelectorAll('[data-slot="aui_turn-pair"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-slot="aui_response-group"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-slot="aui_msg-actions"]')).toHaveLength(1)
    expect(container.querySelector('[data-role="assistant"]')).toBe(original)
    expect(
      [...container.querySelectorAll('[data-role="assistant"]')].map(e => e.getAttribute('data-message-id'))
    ).toEqual([messages[1]!.id, messages[3]!.id])
    const actions = container.querySelector('[data-slot="aui_msg-actions"]') as HTMLElement
    // Default Copy reads only the tail reply; the full-response scope is a
    // separate explicit action (#118864).
    fireEvent.click(within(actions).getByRole('button', { name: /^copy$/i }))
    await waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith('The deployment is verified.'))
    fireEvent.click(within(actions).getByRole('button', { name: /copy full response/i }))
    await waitFor(() =>
      expect(clipboard.writeText).toHaveBeenLastCalledWith('Checking the deployment.\n\nThe deployment is verified.')
    )
    fireEvent.click(within(actions).getByRole('button', { name: /branch/i }))
    expect(branch).toHaveBeenLastCalledWith(messages[3]!.id)

    const pending: ThreadMessage[] = [
      ...messages,
      { ...messages[3]!, role: 'assistant', id: 'next', content: [], status: { type: 'running' } } as ThreadMessage
    ]

    rerender(
      <ThreadRuntime messages={pending}>
        <Thread onBranchInNewChat={branch} />
      </ThreadRuntime>
    )
    await waitFor(() => expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(3))
    expect(container.querySelectorAll('[data-slot="aui_msg-actions"]')).toHaveLength(1)

    unmount()

    const reloaded = render(
      <ThreadRuntime messages={messages}>
        <Thread />
      </ThreadRuntime>
    )

    expect(reloaded.container.querySelectorAll('[data-slot="aui_msg-actions"]')).toHaveLength(1)
    reloaded.unmount()
  }
})

it('ends the response at a real user prompt or unrelated system event', () => {
  const messages = toChatMessages([
    { role: 'user', content: 'First question', timestamp: 1 },
    { role: 'assistant', content: 'First answer', timestamp: 2 },
    { role: 'system', content: 'slash:/model\nmodel changed', timestamp: 3 },
    { role: 'assistant', content: 'Separate answer', timestamp: 4 },
    { role: 'user', content: 'Second question', timestamp: 5 },
    { role: 'assistant', content: 'Second answer', timestamp: 6 }
  ]).map(toRuntimeMessage)

  const { container } = render(
    <ThreadRuntime messages={messages}>
      <Thread />
    </ThreadRuntime>
  )

  expect(container.querySelectorAll('[data-slot="aui_turn-pair"]')).toHaveLength(2)
  expect(container.querySelectorAll('[data-slot="aui_msg-actions"]')).toHaveLength(3)
})

it('collapses process parts while keeping the final text and whole-second duration visible', async () => {
  const messages = toChatMessages([
    { role: 'user', content: 'Create the report', timestamp: 1 },
    { role: 'assistant', content: 'Report completed', timestamp: 1383 }
  ] as SessionMessage[]).map(toRuntimeMessage)

  const assistant = messages[1]!

  const complete = {
    ...assistant,
    content: [
      { type: 'text', text: 'Preparing the report' },
      {
        type: 'tool-call',
        toolCallId: 'report-tool',
        toolName: 'terminal',
        args: { command: 'build-report' },
        result: 'done'
      },
      { type: 'text', text: 'Report completed' }
    ],
    metadata: { ...assistant.metadata, custom: { ...assistant.metadata.custom, durationS: 1382.3093128 } }
  } as ThreadMessage

  const { container } = render(
    <ThreadRuntime messages={[messages[0]!, complete]}>
      <Thread />
    </ThreadRuntime>
  )

  await waitFor(() => expect(container.textContent).toContain('Report completed'))
  expect(within(container).getByText('Preparing the report').closest('[hidden], [style*="display: none"]')).not.toBeNull()
  expect(within(container).getByText('Report completed').closest('[hidden], [style*="display: none"]')).toBeNull()
  const duration = container.querySelector('[data-slot="aui_turn-duration"]')!
  expect(duration.textContent).toContain('Worked for 23m 2s')
  expect(duration.textContent).not.toContain('3093128')
  fireEvent.click(container.querySelector('[data-slot="aui_process-summary"]')!)
  expect(within(container).getByText('Preparing the report').closest('[hidden]')).toBeNull()
})

it('collapses earlier replies as answer text streams and keeps manual expansion available', async () => {
  const messages = toChatMessages([
    { role: 'user', content: 'Check the report', timestamp: 1 },
    { role: 'assistant', content: 'Checking sources', timestamp: 2 },
    { role: 'assistant', content: 'Full final answer', timestamp: 3 }
  ] as SessionMessage[]).map(toRuntimeMessage)

  const interim = messages[1]!

  const renderThread = (status: ThreadMessage['status']) => (
    <ThreadRuntime isRunning messages={[messages[0]!, interim, { ...messages[2]!, status } as ThreadMessage]}>
      <Thread />
    </ThreadRuntime>
  )

  const { container, rerender } = render(renderThread({ type: 'running' }))
  const update = () => within(container).getByText('Checking sources')
  await waitFor(() => expect(update().closest('[hidden]')).not.toBeNull())
  expect(within(container).getByText('Full final answer').closest('[hidden]')).toBeNull()
  fireEvent.click(container.querySelector('[data-slot="aui_process-summary"]')!)
  await waitFor(() => expect(update().closest('[hidden]')).toBeNull())
  fireEvent.click(container.querySelector('[data-slot="aui_process-summary"]')!)
  rerender(renderThread({ type: 'complete', reason: 'stop' }))
  await waitFor(() => expect(update().closest('[hidden]')).not.toBeNull())
  expect(within(container).getByText('Full final answer').closest('[hidden]')).toBeNull()
  fireEvent.click(container.querySelector('[data-slot="aui_process-summary"]')!)
  await waitFor(() => expect(update().closest('[hidden]')).toBeNull())
  fireEvent.click(container.querySelector('[data-slot="aui_process-summary"]')!)
  rerender(renderThread({ type: 'incomplete', reason: 'error' }))
  await waitFor(() => expect(update().closest('[hidden]')).toBeNull())
})


it('keeps active tools visible and collapses process parts when streamed answer text arrives', async () => {
  const messages = toChatMessages([
    { role: 'user', content: 'Analyze the report', timestamp: 1 },
    { role: 'assistant', content: 'Checking sources', timestamp: 2 }
  ] as SessionMessage[]).map(toRuntimeMessage)

  const tool = { type: 'tool-call', toolCallId: 'check-report', toolName: 'terminal', args: { command: 'check' } }

  const renderReply = (finished: boolean, resumesTools = false) => (
    <ThreadRuntime messages={[messages[0]!, {
      ...messages[1]!,
      status: { type: 'running' },
      content: [
        { type: 'text', text: 'Checking sources' },
        { ...tool, ...(finished ? { completedAt: 3 } : {}) },
        ...(finished ? [{ type: 'text', text: 'The main conclusion is' }] : []),
        ...(resumesTools ? [{ ...tool, toolCallId: 'verify-again' }] : [])
      ]
    } as ThreadMessage]}>
      <Thread />
    </ThreadRuntime>
  )

  const { container, rerender } = render(renderReply(false))
  const process = () => within(container).getByText('Checking sources')
  expect(process().closest('[hidden]')).toBeNull()
  expect(container.querySelector('[data-slot="aui_process-summary"]')).toBeNull()
  rerender(renderReply(true))
  await waitFor(() => expect(process().closest('[hidden]')).not.toBeNull())
  expect(within(container).getByText('The main conclusion is').closest('[hidden]')).toBeNull()
  fireEvent.click(container.querySelector('[data-slot="aui_process-summary"]')!)
  expect(process().closest('[hidden]')).toBeNull()
  fireEvent.click(container.querySelector('[data-slot="aui_process-summary"]')!)
  rerender(renderReply(true, true))
  await waitFor(() => expect(process().closest('[hidden]')).toBeNull())
})


it('keeps searched pages expandable and linked outside the collapsed execution process', async () => {
  const messages = toChatMessages([
    { role: 'user', content: 'Find the report', timestamp: 1 },
    { role: 'assistant', content: 'Report found', timestamp: 2 }
  ] as SessionMessage[]).map(toRuntimeMessage)
  const reply = { ...messages[1]!, content: [
    { type: 'tool-call', toolName: 'web_search', toolCallId: 'search-report', args: { query: 'Annual report' }, result: { results: [{ title: 'Official annual report', url: 'https://example.com/report', snippet: 'Long search description' }] } },
    { type: 'text', text: 'Report found' }
  ] } as ThreadMessage
  const { container } = render(<ThreadRuntime messages={[messages[0]!, reply]}><Thread /></ThreadRuntime>)
  const sources = container.querySelector('[data-slot="web-search-sources"]') as HTMLDetailsElement
  expect(sources).not.toBeNull()
  expect(sources.closest('[hidden]')).toBeNull()
  fireEvent.click(sources.querySelector('summary')!)
  const link = within(sources).getByRole('link', { name: /Official annual report/ })
  expect(link.getAttribute('href')).toBe('https://example.com/report')
  expect(sources.textContent).not.toContain('Long search description')
})
