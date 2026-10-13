import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo, SidebarSessionsResponse } from '@/hermes'
import { $sessions, setSessions, setSessionsLoading } from '@/store/session'

import { deferred } from '../../../test/deferred'

import { useSessionListActions } from './use-session-list-actions'

// Browser build (lib/browser-shell.ts): reloading the page with a session open
// activates the one gateway twice (boot, then opening the routed session), so
// the sidebar's first page lands one activation late. Upstream drops such a
// page; the browser build keeps it, or the sidebar shows only the opened
// session until something else refreshes it.

const row = (id: string): SessionInfo =>
  ({
    ended_at: null,
    id,
    input_tokens: 0,
    is_active: false,
    last_active: 1000,
    message_count: 3,
    model: 'm',
    output_tokens: 0,
    preview: 'hey',
    profile: 'default',
    source: 'desktop',
    started_at: 900,
    title: `Chat ${id}`
  }) as SessionInfo

const page = (sessions: SessionInfo[]): SidebarSessionsResponse => ({
  recents: { sessions },
  cron: { sessions: [] },
  messaging: { sessions: [] }
})

const listSidebarSessions = vi.fn()
const gatewayScope = vi.hoisted(() => ({ epoch: 0 }))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCronJobs: () => Promise.resolve([]),
  listSidebarSessions: (...args: unknown[]) => listSidebarSessions(...args)
}))

vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gatewayActivationEpoch: () => gatewayScope.epoch
}))

vi.mock('@/store/projects', () => ({
  $removedSessionIds: { get: () => new Set<string>() }
}))

beforeEach(() => {
  gatewayScope.epoch = 0
  listSidebarSessions.mockReset()
  setSessions([])
  setSessionsLoading(false)
})

afterEach(() => {
  delete window.document.documentElement.dataset.hermesBrowser
  setSessions([])
  setSessionsLoading(false)
})

async function reloadWithSessionOpen(): Promise<string[]> {
  const pending = deferred<SidebarSessionsResponse>()
  listSidebarSessions.mockReturnValue(pending.promise)
  const { result } = renderHook(() => useSessionListActions({ profileScope: 'default' }))

  let refresh!: Promise<void>

  act(() => {
    refresh = result.current.refreshSessions()
  })

  // Opening the routed session puts it in the list and activates the same gateway again.
  setSessions([row('opened')])
  gatewayScope.epoch += 1

  await act(async () => {
    pending.resolve(page([row('opened'), row('a'), row('b'), row('c')]))
    await refresh
  })

  return $sessions
    .get()
    .map(session => session.id)
    .sort()
}

describe('sidebar page after the gateway was activated again', () => {
  it('shows the whole page in the browser build', async () => {
    window.document.documentElement.dataset.hermesBrowser = 'production'

    expect(await reloadWithSessionOpen()).toEqual(['a', 'b', 'c', 'opened'])
  })

  it('drops it outside the browser build, as upstream does', async () => {
    expect(await reloadWithSessionOpen()).toEqual(['opened'])
  })
})
