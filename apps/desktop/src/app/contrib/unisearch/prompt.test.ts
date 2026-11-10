import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { sendAgent, sendProfile, release, api } = vi.hoisted(() => ({
  sendAgent: vi.fn(async (_connection: string, _profile: string, _method: string, params: unknown) => params),
  sendProfile: vi.fn(),
  release: vi.fn(),
  api: vi.fn()
}))

vi.mock('@/store/gateway', () => ({
  requestGatewayForAgent: sendAgent,
  requestGatewayForProfile: sendProfile,
  retainGatewayForSessionTurn: vi.fn(async () => release)
}))
vi.mock('@/store/session-gone-latch', () => ({ resetBackgroundPollingGuardAfterRebind: vi.fn() }))

import { requestForSessionProfile } from '@/store/session-request-router'

import { deferBuiltinWebReferences } from './prompt'

const owner = { connectionId: 'local', profile: 'default' }
const text = '请读 @url:`https://example.com/a?x=1&y=2#part`，并参考 @file:`notes.txt`。'
const ambient = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { api } })
  api.mockResolvedValue({ active_extract_backend: 'builtin_parse' })
})
afterEach(() => vi.useRealTimers())

describe('Builtin URL entry uses the owned tool quality contract', () => {
  it('submits ordinary links without native preread while preserving user intent and other refs', async () => {
    const params = { session_id: 's', text, queued: true, title_preview: text }
    const result = await requestForSessionProfile(owner, ambient, 'prompt.submit', params)
    expect(result).toEqual({ ...params, text: '请读 `https://example.com/a?x=1&y=2#part`，并参考 @file:`notes.txt`。' })
    expect(params.text).toBe(text)
    expect(api).toHaveBeenCalledWith({ connectionId: 'local', profile: 'default', priority: 'foreground', path: '/api/tools/toolsets/web/config' })
    expect(sendAgent).toHaveBeenCalledTimes(1)
    expect(ambient).not.toHaveBeenCalled()
  })

  it.each(['unicrawl', 'firecrawl', 'tavily', 'parallel', null])('preserves %s preread and exact payload', async backend => {
    api.mockResolvedValue({ active_extract_backend: backend })
    const params = { session_id: 's', text }
    expect(await requestForSessionProfile(owner, ambient, 'prompt.submit', params)).toEqual(params)
  })

  it('does not query capabilities for ordinary URLs, file refs, MCP calls or interruption', async () => {
    for (const [method, prompt] of [['prompt.submit', '看 https://example.com'], ['prompt.submit', '@file:`a.txt`'], ['tool.call', text], ['interrupt', text]]) {
      await requestForSessionProfile(owner, ambient, method, { session_id: 's', text: prompt })
    }

    expect(api).not.toHaveBeenCalled()
  })

  it('resolves A → B → A independently and pins the owner during the lookup', async () => {
    api.mockImplementation(async (request: { connectionId: string }) => ({ active_extract_backend: request.connectionId === 'A' ? 'builtin_parse' : 'tavily' }))

    for (const connectionId of ['A', 'B', 'A']) {
      const route = { connectionId, profile: 'same-name', mode: 'remote' as const }
      const pending = requestForSessionProfile(route, ambient, 'prompt.submit', { session_id: 'same-id', text })
      route.connectionId = 'changed-window'
      const result = await pending as { text: string }
      expect(result.text.includes('@url:')).toBe(connectionId === 'B')
    }

    expect(sendAgent.mock.calls.map(call => call[0])).toEqual(['A', 'B', 'A'])
    expect(api.mock.calls.map(call => call[0].connectionId)).toEqual(['A', 'B', 'A'])
  })

  it('uses fresh selection when the same profile switches backends', async () => {
    api.mockResolvedValueOnce({ active_extract_backend: 'builtin_parse' }).mockResolvedValueOnce({ active_extract_backend: 'unicrawl' })
    const first = await requestForSessionProfile(owner, ambient, 'prompt.submit', { text }) as { text: string }
    const second = await requestForSessionProfile(owner, ambient, 'prompt.submit', { text }) as { text: string }
    expect(first.text.includes('@url:')).toBe(false)
    expect(second.text).toBe(text)
  })

  it('does not send after capability failure or cancellation', async () => {
    api.mockRejectedValueOnce(new Error('connection closed'))
    await expect(requestForSessionProfile(owner, ambient, 'prompt.submit', { text })).rejects.toThrow('connection closed')
    const controller = new AbortController()
    api.mockImplementationOnce(async () => { controller.abort();

 return { active_extract_backend: 'builtin_parse' } })
    await expect(requestForSessionProfile(owner, ambient, 'prompt.submit', { text }, undefined, controller.signal)).rejects.toThrow()
    expect(sendAgent).not.toHaveBeenCalled()
  })

  it.each(['session.interrupt', 'session.close'])('cancels waiting sends on %s, only for that owner', async method => {
    const resolvers: Array<(value: unknown) => void> = []
    api.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)))
    const first = requestForSessionProfile({ connectionId: 'A', profile: 'same' }, ambient, 'prompt.submit', { session_id: 'same', text })
    const second = requestForSessionProfile({ connectionId: 'B', profile: 'same' }, ambient, 'prompt.submit', { session_id: 'same', text })
    const rejected = expect(first).rejects.toThrow('cancelled')
    await requestForSessionProfile({ connectionId: 'A', profile: 'same' }, ambient, method, { session_id: 'same' })
    await rejected
    resolvers.forEach(resolve => resolve({ active_extract_backend: 'builtin_parse' }))
    await second
    expect(sendAgent.mock.calls.filter(call => call[2] === 'prompt.submit').map(call => call[0])).toEqual(['B'])
  })

  it('bounds a stalled capability lookup without a late submit', async () => {
    vi.useFakeTimers()
    let finish!: (value: unknown) => void
    api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = requestForSessionProfile(owner, ambient, 'prompt.submit', { text })
    const rejected = expect(pending).rejects.toThrow('无法确认')
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    finish({ active_extract_backend: 'builtin_parse' })
    await Promise.resolve()
    expect(sendAgent).not.toHaveBeenCalled()
  })

  it.each(['@file:notes.txt', '@url:https://other.test', '@diff', '@custom:secret'])('does not activate nested %s context from URL data', async nested => {
    const params = { session_id: 's', text: `看 @url:\`https://example.com/?q=${nested}\`` }
    await expect(requestForSessionProfile(owner, ambient, 'prompt.submit', params)).rejects.toThrow('无法安全读取')
    expect(sendAgent).not.toHaveBeenCalled()
  })

  it('preserves URL values, quoting, fragments, duplicates and other context types', () => {
    const original = '@url:"https://a.test/a" @url:\'https://b.test/#c\' @url:https://a.test/a @file:`a b` @session:123'
    expect(deferBuiltinWebReferences(original)).toBe('"https://a.test/a" \'https://b.test/#c\' https://a.test/a @file:`a b` @session:123')
  })
})
