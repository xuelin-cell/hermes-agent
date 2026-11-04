import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { chatMessagesEquivalent } from '@/app/session/hooks/use-session-actions/utils'
import type { ClientSessionState } from '@/app/types'
import { toChatMessages } from '@/lib/chat-messages'
import { createClientSessionState, toRuntimeMessage } from '@/lib/chat-runtime'
import { $currentUsage } from '@/store/session'

import { type MessageStreamHarness, renderMessageStream } from './test-harness'

const SID = 'session-1'
// $currentUsage mirrors the primary session; ClientSessionState.usage drives
// the same status bar when a secondary tile is focused.
const BASELINE = { calls: 2, input: 500, output: 40, total: 540 }

let stream: MessageStreamHarness
let sessionStates = new Map<string, ClientSessionState>()

function mountStream() {
  stream = renderMessageStream(SID, { states: sessionStates })
}

describe('useMessageStream status-bar usage scoping', () => {
  beforeEach(() => {
    sessionStates = new Map([[SID, { ...createClientSessionState(), usage: { ...BASELINE } }]])
    $currentUsage.set({ ...BASELINE })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('merges a live session.usage tick from the focused session', () => {
    mountStream()

    act(() =>
      stream.handleEvent({
        payload: { usage: { context_percent: 42, input: 1200, total: 1280 } },
        session_id: SID,
        type: 'session.usage'
      })
    )

    // Merge, not replace: fields absent from the tick keep their prior values.
    expect($currentUsage.get()).toEqual({ ...BASELINE, context_percent: 42, input: 1200, total: 1280 })
    expect(sessionStates.get(SID)?.usage).toEqual({
      ...BASELINE,
      context_percent: 42,
      input: 1200,
      total: 1280
    })
  })

  it('caches a background session.usage tick without overwriting the primary status bar', () => {
    mountStream()

    act(() =>
      stream.handleEvent({
        payload: { usage: { input: 9999, total: 9999 } },
        session_id: 'background-session',
        type: 'session.usage'
      })
    )

    expect($currentUsage.get()).toEqual(BASELINE)
    expect(sessionStates.get('background-session')?.usage).toEqual({
      calls: 0,
      input: 9999,
      output: 0,
      total: 9999
    })
  })

  it('applies message.complete usage from the focused session', () => {
    mountStream()

    act(() =>
      stream.handleEvent({
        payload: { text: 'done', usage: { calls: 3, input: 1500, output: 90, total: 1590 } },
        session_id: SID,
        type: 'message.complete'
      })
    )

    expect($currentUsage.get()).toEqual({ calls: 3, input: 1500, output: 90, total: 1590 })
  })

  it('ignores message.complete usage from a background session', () => {
    mountStream()

    act(() =>
      stream.handleEvent({
        payload: { text: 'done', usage: { calls: 9, input: 9999, output: 999, total: 9999 } },
        session_id: 'background-session',
        type: 'message.complete'
      })
    )

    expect($currentUsage.get()).toEqual(BASELINE)
  })

  it('keeps per-turn usage on the answer through live completion, history folding and runtime conversion', () => {
    mountStream()

    const usage = {
      input_tokens: 1200,
      output_tokens: 80,
      total_tokens: 1280,
      cache_read_tokens: 400,
      cache_write_tokens: 0
    }

    act(() => stream.handleEvent({ session_id: SID, type: 'message.start' }))
    act(() =>
      stream.handleEvent({
        payload: { text: 'done', turn_token_usage: usage, usage: { total: 9999 } },
        session_id: SID,
        type: 'message.complete'
      })
    )
    const live = stream.state().messages.at(-1)!
    expect(live.turnTokenUsage).toEqual(usage)
    expect(toRuntimeMessage(live).metadata.custom.turnTokenUsage).toEqual(usage)
    expect($currentUsage.get().total).toBe(9999)

    const restored = toChatMessages([
      { role: 'user', content: 'question', timestamp: 1 },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call', type: 'function', function: { name: 'terminal', arguments: '{}' } }],
        timestamp: 2
      },
      { role: 'tool', tool_call_id: 'call', content: 'ok', timestamp: 3 },
      { role: 'assistant', content: 'done', timestamp: 4, display_metadata: { turn_token_usage: usage } }
    ])

    const reply = restored.at(-1)!
    expect(reply.turnTokenUsage).toEqual(live.turnTokenUsage)
    expect(toRuntimeMessage(reply).metadata.custom.turnTokenUsage).toEqual(usage)
    expect(chatMessagesEquivalent(reply, { ...reply, turnTokenUsage: { ...usage } })).toBe(true)
    expect(chatMessagesEquivalent(reply, { ...reply, turnTokenUsage: undefined })).toBe(false)
    expect(toChatMessages([{ role: 'assistant', content: 'older reply' }])[0].turnTokenUsage).toBeUndefined()

    const stoppedUsage = { ...usage, input_tokens: 100, output_tokens: 10, total_tokens: 110, cache_read_tokens: 0 }
    const state = stream.state()
    stream.states.set(SID, {
      ...state,
      interrupted: true,
      messages: [
        ...state.messages,
        { id: 'user-stopped', role: 'user', parts: [{ type: 'text', text: 'next question' }] },
        { id: 'reply-stopped', role: 'assistant', parts: [{ type: 'text', text: 'partial reply' }] }
      ]
    })
    act(() =>
      stream.handleEvent({
        session_id: SID,
        type: 'message.complete',
        payload: { text: 'partial reply', status: 'interrupted', turn_token_usage: stoppedUsage }
      })
    )
    expect(stream.state().messages.at(-1)?.turnTokenUsage).toEqual(stoppedUsage)
    expect(stream.state().messages.find(message => message.id === live.id)?.turnTokenUsage).toEqual(usage)
  })
})
