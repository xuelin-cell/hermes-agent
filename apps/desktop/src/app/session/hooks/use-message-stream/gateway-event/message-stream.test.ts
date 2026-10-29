import { afterEach, describe, expect, it, vi } from 'vitest'

const { refreshSupportedSessionControlAfterTurn } = vi.hoisted(() => ({
  refreshSupportedSessionControlAfterTurn: vi.fn(async () => undefined)
}))

vi.mock('@/store/session-control', () => ({ refreshSupportedSessionControlAfterTurn }))

import type { GatewayEventName } from '@hermes/shared'

import { $enterpriseShell } from '@/lib/enterprise-mt'
import { $billingBlock, clearBillingBlock } from '@/store/billing-block'

import { handleMessageStreamEvent } from './message-stream'
import type { GatewayEventContext } from './types'

function context(type: GatewayEventName): GatewayEventContext {
  return {
    deps: {
      activeGatewayProfile: 'default',
      activeSessionIdRef: { current: 's1' },
      appendAssistantDelta: vi.fn(),
      appendReasoningDelta: vi.fn(),
      compactedTurnRef: { current: new Set() },
      completeAssistantMessage: vi.fn(),
      failAssistantMessage: vi.fn(),
      finalizeInterimAssistantMessage: vi.fn(),
      flushQueuedDeltas: vi.fn(),
      dropQueuedDeltas: vi.fn(),
      hydrateFromStoredSession: vi.fn(async () => undefined),
      lastCwdInfoSessionRef: { current: null },
      nativeSubagentSessionsRef: { current: new Set() },
      queryClient: {} as GatewayEventContext['deps']['queryClient'],
      refreshHermesConfig: vi.fn(async () => undefined),
      scheduleSessionsRefresh: vi.fn(),
      sessionInterrupted: vi.fn(() => false),
      sessionStateByRuntimeIdRef: { current: new Map() },
      updateSessionState: vi.fn(),
      upsertToolCall: vi.fn()
    },
    event: { type },
    explicitSid: 's1',
    fromActiveSource: () => true,
    isActiveEvent: false,
    occurredAt: 1_700_000_100,
    payload: { text: 'completed' },
    scheduleConfigRefresh: vi.fn(),
    sessionId: 's1'
  }
}

describe('handleMessageStreamEvent session-control integration', () => {
  it('refreshes only after message.complete, through the store seam', () => {
    expect(handleMessageStreamEvent(context('message.delta'))).toBe(true)
    expect(refreshSupportedSessionControlAfterTurn).not.toHaveBeenCalled()

    expect(handleMessageStreamEvent(context('message.complete'))).toBe(true)
    expect(refreshSupportedSessionControlAfterTurn).toHaveBeenCalledTimes(1)
    expect(refreshSupportedSessionControlAfterTurn).toHaveBeenCalledWith('s1')
  })
})

describe('handleMessageStreamEvent billing wall', () => {
  const billed = (): GatewayEventContext => ({
    ...context('message.complete'),
    payload: {
      billing: {
        billing_url: '',
        is_nous: false,
        message: 'Custom reported that billing is exhausted.',
        model: 'deepseek-v4-flash',
        provider: 'custom',
        provider_label: 'Custom'
      },
      text: ''
    }
  })

  afterEach(() => {
    $enterpriseShell.set(false)
    clearBillingBlock()
  })

  it('raises the top-up banner for a personal provider account', () => {
    handleMessageStreamEvent(billed())
    expect($billingBlock.get()?.block.provider).toBe('custom')
  })

  it('leaves a quota refusal to the error card in the cloud enterprise mode', () => {
    $enterpriseShell.set(true)
    handleMessageStreamEvent(billed())
    expect($billingBlock.get()).toBeNull()
  })
})
