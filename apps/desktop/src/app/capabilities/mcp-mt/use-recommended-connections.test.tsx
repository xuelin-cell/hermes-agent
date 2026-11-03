import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { LocalConnectorRequest, LocalConnectorResult } from '../../../../electron/open-connector/contract'

import { useRecommendedConnections } from './use-recommended-connections'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete document.documentElement.dataset.hermesBrowser
  delete window.hermesDesktop.cloudConnectorIds
})

it('opens cloud default and expert scopes without desktop connection settings', async () => {
  document.documentElement.dataset.hermesBrowser = 'production'
  const localConnectors = vi.fn(async (): Promise<LocalConnectorResult> => ({ connectors: [{ id: 'amap', connected: false }] }))
  const getConnectionConfig = vi.fn(() => { throw new Error('Desktop-only method') })
  window.hermesDesktop = { ...window.hermesDesktop, cloudConnectorIds: ['amap'], localConnectors, getConnectionConfig }
  const { result, rerender } = renderHook(({ profile }) => useRecommendedConnections({ connectionId: 'local', profile }), { initialProps: { profile: 'default' } })
  await waitFor(() => expect(result.current.available).toBe(true))
  expect(localConnectors).toHaveBeenCalledWith({ operation: 'list', profile: 'default' })
  expect(getConnectionConfig).not.toHaveBeenCalled()
  rerender({ profile: 'expert' })
  await waitFor(() => expect(localConnectors).toHaveBeenCalledWith({ operation: 'list', profile: 'expert' }))
  expect(result.current.available).toBe(true)
})

it('never paints a late local reply into another profile or sends local credentials to a remote route', async () => {
  let resolveA: (value: LocalConnectorResult) => void = () => undefined

  const localConnectors = vi.fn((input: LocalConnectorRequest): Promise<LocalConnectorResult> =>
    input.profile === 'A'
      ? new Promise(resolve => {
          resolveA = resolve
        })
      : Promise.resolve({ connectors: [] })
  )

  window.hermesDesktop = { ...window.hermesDesktop, localConnectors }

  const { result, rerender } = renderHook(
    ({ connectionId, profile }) => useRecommendedConnections({ connectionId, profile }),
    { initialProps: { connectionId: 'local', profile: 'A' } }
  )

  await waitFor(() => expect(localConnectors).toHaveBeenCalledOnce())
  rerender({ connectionId: 'remote-server', profile: 'B' })
  await act(async () => resolveA({ connectors: [{ id: 'qq_mail', connected: true }] }))
  expect(result.current.rows).toEqual([])
  expect(result.current.available).toBe(false)
  await act(async () => {
    expect(
      await result.current.request('connect', 'qq_mail', { email: 'test@qq.com', authorizationCode: 'never-sent' })
    ).toBe(false)
  })
  expect(localConnectors).toHaveBeenCalledOnce()
})

it('polls delayed browser OAuth to completion without asking the renderer to mount MCP', async () => {
  let authorized = false

  const localConnectors = vi.fn(async (input: LocalConnectorRequest): Promise<LocalConnectorResult> => {
    return {
      connectors: [{ id: 'qcc_mcp', connected: input.operation === 'list' && authorized }]
    }
  })

  const api = vi.fn()
  window.hermesDesktop = { ...window.hermesDesktop, localConnectors, api }
  vi.useFakeTimers()
  const { result } = renderHook(() => useRecommendedConnections({ connectionId: 'local', profile: 'A' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(result.current.available).toBe(true)
  await act(async () => {
    await result.current.request('authorize', 'qcc_mcp')
  })
  expect(result.current.pending).toBe('qcc_mcp')
  authorized = true
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(localConnectors).not.toHaveBeenCalledWith({ operation: 'enable', profile: 'A', id: 'qcc_mcp' })
  expect(result.current.rows).toEqual([{ id: 'qcc_mcp', connected: true }])
  expect(result.current.pending).toBeNull()
  expect(api).not.toHaveBeenCalled()
})

it('refreshes a connection completed outside this page and retries transient failures', async () => {
  let attempt = 0

  const localConnectors = vi.fn(async (): Promise<LocalConnectorResult> => {
    attempt += 1

    if (attempt === 2) {
      throw new Error('temporary failure')
    }

    return { connectors: [{ id: 'qcc_mcp', connected: attempt >= 3 }] }
  })

  window.hermesDesktop = { ...window.hermesDesktop, localConnectors }
  vi.useFakeTimers()
  const { result } = renderHook(() => useRecommendedConnections({ connectionId: 'local', profile: 'A' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(result.current.rows).toEqual([{ id: 'qcc_mcp', connected: false }])

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(result.current.rows).toEqual([{ id: 'qcc_mcp', connected: false }])

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(result.current.rows).toEqual([{ id: 'qcc_mcp', connected: true }])
  expect(result.current.error).toBe('')
})
