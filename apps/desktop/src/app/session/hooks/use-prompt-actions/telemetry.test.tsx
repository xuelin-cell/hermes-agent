import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { continueNote } from '@/app/chat/composer/interrupted-mt/interrupted-turn'
import { en } from '@/i18n/en'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $connection, setSessions } from '@/store/session'

import { useSubmitPrompt } from './submit'

vi.mock('@/hermes', () => ({
  getLatestSessionMessages: vi.fn(async () => ({ messages: [], session_id: 'stored' })),
  getSession: vi.fn(),
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  setApiRequestProfile: vi.fn(),
  PROMPT_SUBMIT_REQUEST_TIMEOUT_MS: 1_800_000
}))

afterEach(() => {
  cleanup()
  setSessions([])
  $connection.set(null)
  vi.unstubAllGlobals()
})

function setup(submit: () => Promise<unknown>) {
  let state = createClientSessionState()
  const calls: { method: string; params?: Record<string, unknown> }[] = []

  const requestGateway = async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
    calls.push({ method, params })

    return (method === 'prompt.submit' ? await submit() : {}) as T
  }

  const hook = renderHook(() => useSubmitPrompt({
    activeSessionIdRef: { current: 'runtime' }, busyRef: { current: false }, copy: en.desktop,
    createBackendSessionForSend: async () => 'runtime', getRoutedStoredSessionId: () => null,
    getRuntimeIdForStoredSession: () => 'runtime', getRouteToken: () => 'route', requestGateway,
    runtimeIdByStoredSessionIdRef: { current: new Map([['stored', 'runtime']]) },
    resumeStoredSession: async () => {}, selectedStoredSessionIdRef: { current: 'stored' },
    syncAttachmentsForSubmit: async (sessionId, attachments) => ({ sessionId, attachments }),
    updateSessionState: (_session, updater) => (state = updater(state))
  }))

  return { ...hook, calls }
}

it('reports the selected tag only after prompt acceptance, through the plugin command', async () => {
  let accept!: (value: unknown) => void
  const pending = new Promise(resolve => { accept = resolve })
  const { result, calls } = setup(() => pending)
  const tag = { id: 'server-tag-id', name: '帮我写作' }
  let sending!: Promise<boolean>
  act(() => { sending = result.current('请假消息', { skillTag: tag }) })
  await waitFor(() => expect(calls.some(call => call.method === 'prompt.submit')).toBe(true))
  expect(calls.some(call => call.method === 'command.dispatch')).toBe(false)
  await act(async () => { accept({}); expect(await sending).toBe(true) })
  await waitFor(() => expect(calls.some(call => call.method === 'command.dispatch')).toBe(true))
  const command = calls.find(call => call.method === 'command.dispatch')!.params!
  expect(command).toMatchObject({ session_id: 'runtime', name: 'usage-report' })
  const event = JSON.parse(String(command.arg).slice('tag '.length))
  expect(event.tag).toEqual(tag)
  expect(event.id).toBeTruthy()
  expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false)
  expect(calls.find(call => call.method === 'prompt.submit')!.params).not.toHaveProperty('skillTag')
})

it('does not report a tag when the prompt fails', async () => {
  const { result, calls } = setup(async () => { throw new Error('submission rejected') })
  await act(async () => {
    expect(await result.current('message', { skillTag: { id: 'tag', name: '标签' } })).toBe(false)
  })
  expect(calls.some(call => call.method === 'command.dispatch')).toBe(false)
})

it('marks hidden and resumed sends without recording their system note as user input', async () => {
  const record = vi.fn<(input: unknown) => Promise<void>>(async () => {})
  vi.stubGlobal('hermesDesktop', { rememberUsageInput: record })
  vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) } })
  const { result, calls } = setup(async () => ({}))
  const note = continueNote('原来的请求')

  await act(async () => {
    expect(await result.current(note, { displayKind: 'hidden' })).toBe(true)
  })
  expect(record.mock.calls[0][0]).toMatchObject({ requestKind: 'hidden' })
  expect(record.mock.calls[0][0]).not.toHaveProperty('userInput')

  await act(async () => {
    expect(await result.current(note, { displayKind: 'hidden', usageResume: { executionId: 'a'.repeat(64) } })).toBe(true)
  })
  expect(record.mock.calls[1][0]).toMatchObject({ requestKind: 'resume', resumeFrom: 'a'.repeat(64) })
  expect(record.mock.calls[1][0]).not.toHaveProperty('userInput')
  const sends = calls.filter(call => call.method === 'prompt.submit')
  expect(sends).toHaveLength(2)
  expect(sends.every(call => call.params?.text === note && call.params?.display_kind === 'hidden')).toBe(true)
  expect(sends.every(call => !('usageResume' in call.params!) && !('resumeFrom' in call.params!))).toBe(true)
})
