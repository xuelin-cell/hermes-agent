import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $apiRequestScope } from '@/api/client'
import { $showReasoning } from '@/store/reasoning-disclosure'

import { Thread } from '.'

const createdAt = new Date('2026-05-01T00:00:00.000Z')

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', TestResizeObserver)
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 0)
)
vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
vi.stubGlobal('CSS', { escape: (str: string) => str })

Element.prototype.scrollTo = function scrollTo() {}

Element.prototype.animate = function animate() {
  return { cancel() {}, finished: Promise.resolve() } as unknown as Animation
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  $showReasoning.set(true)
  $apiRequestScope.set({ profile: null, connectionId: null })
})

const assistantMetadata = { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }

function user(id: string, text: string): ThreadMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    attachments: [],
    createdAt,
    metadata: { custom: {} }
  } as ThreadMessage
}

function assistant(id: string, text: string, running: boolean): ThreadMessage {
  return {
    id,
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    status: running ? { type: 'running' } : { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: assistantMetadata
  } as ThreadMessage
}

function Harness({ messages }: { messages: ThreadMessage[] }) {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages,
    isRunning: messages.at(-1)?.status?.type === 'running',
    onNew: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  )
}

const shareId = 'published-artifact-1234'

const record = {
  key: 'file:session:/work/report.md',
  shareId,
  title: 'report.md',
  url: 'https://share.example/authoritative',
  hash: 'hash',
  version: 1,
  updatedAt: 'today'
}

function sharedReply(): ThreadMessage {
  const message = assistant('a1', '', false)

  return {
    ...message,
    content: [
      {
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'tool_call',
        args: { calls: [{ name: 'publish_artifact', arguments: { path: 'report.md' } }] },
        argsText: '',
        result: JSON.stringify({ share_id: shareId, url: 'https://untrusted.example/ignored' })
      }
    ]
  } as ThreadMessage
}

it('answer-only chat exposes existing artifact shares and confirms revocation; failure retains retry', async () => {
  $showReasoning.set(false)
  let current: typeof record | null = record
  const inspect = vi.fn(async () => current)

  const revoke = vi
    .fn()
    .mockRejectedValueOnce(new Error('delete failed'))
    .mockImplementation(async () => {
      current = null
    })

  const writeClipboard = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('hermesDesktop', { artifactShare: { inspect, revoke, onChanged: () => () => {} }, writeClipboard })
  const messages = [user('u1', 'share report.md'), sharedReply()]
  const view = render(<Harness messages={messages} />)
  const card = await screen.findByRole('region', { name: 'Share artifact' })
  await within(card).findByText(record.url)
  expect(inspect).toHaveBeenCalledWith({ shareId })
  fireEvent.click(within(card).getByRole('button', { name: 'Copy shared link' }))
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(record.url))
  fireEvent.click(within(card).getByRole('button', { name: 'Revoke shared link' }))
  const dialog = await screen.findByRole('dialog', { name: 'Revoke shared link' })
  expect(revoke).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(revoke).not.toHaveBeenCalled()
  fireEvent.click(within(card).getByRole('button', { name: 'Revoke shared link' }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke shared link' }))
  await screen.findByText('delete failed')
  expect(within(card).getByText(record.url)).toBeTruthy()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke shared link' }))
  await within(card).findByText('Sharing was revoked or this link is no longer available.')
  expect(revoke).toHaveBeenLastCalledWith(record.key, shareId)
  expect(within(card).queryByRole('button', { name: 'Copy shared link' })).toBeNull()
  view.unmount()
  render(<Harness messages={messages} />)
  await screen.findByText('Sharing was revoked or this link is no longer available.')
})

it('account transitions discard late reads and native changes refresh the same share ID', async () => {
  let resolveOld!: (value: typeof record) => void

  const inspect = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOld = resolve
        })
    )
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(record)
    .mockResolvedValueOnce(null)

  let changed!: (key: string) => void
  vi.stubGlobal('hermesDesktop', {
    artifactShare: {
      inspect,
      revoke: vi.fn(),
      onChanged: (callback: typeof changed) => {
        changed = callback

        return () => {}
      }
    }
  })
  render(<Harness messages={[user('u1', 'share report'), sharedReply()]} />)
  await waitFor(() => expect(inspect).toHaveBeenCalledTimes(1))
  act(() => $apiRequestScope.set({ connectionId: 'B', profile: 'B' }))
  await screen.findByText('Sharing was revoked or this link is no longer available.')
  await act(async () => resolveOld(record))
  expect(screen.queryByText(record.url)).toBeNull()
  act(() => $apiRequestScope.set({ connectionId: null, profile: null }))
  await screen.findByText(record.url)
  act(() => changed(record.key))
  await screen.findByText('Sharing was revoked or this link is no longer available.')
  expect(screen.queryByText(record.url)).toBeNull()
})
