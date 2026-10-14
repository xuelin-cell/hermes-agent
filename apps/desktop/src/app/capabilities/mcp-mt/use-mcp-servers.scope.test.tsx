import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { HermesApiRequest } from '@/global'
import { HermesGateway, type ProfileScope } from '@/hermes'
import { probeCache } from '@/lib/mcp-probe-cache'
import type { McpServers } from '@/lib/mcp-servers'
import { queryClient } from '@/lib/query-client'

const { routedRequest, notifyError } = vi.hoisted(() => ({ routedRequest: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/store/gateway', () => ({ requestGatewayForAgent: routedRequest }))
vi.mock('@/store/profile', () => ({
  $activeGatewayProfile: atom('chat'),
  normalizeProfileKey: (name?: string) => name || 'default'
}))
vi.mock('@/store/connections', () => ({ $activeConnectionId: atom('local') }))
vi.mock('@/store/session', () => ({ $activeSessionId: atom('chat-session') }))
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError }))

const { useMcpServers } = await import('../mcp/use-mcp-servers')
const api = vi.fn()

beforeEach(() => {
  queryClient.clear()
  probeCache.clear()
  vi.clearAllMocks()
  routedRequest.mockResolvedValue({ status: 'reloaded' })
  api.mockImplementation(async (request: HermesApiRequest) => {
    if (request.path === '/api/config') {
      return { mcp_servers: { echo: { command: 'node', enabled: false } } }
    }

    if (request.path === '/api/mcp/catalog') {
      return { entries: [] }
    }

    return { ok: true, tools: [] }
  })
  vi.stubGlobal('hermesDesktop', { api })
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
})

/** 使用真实配置查询、控制器和 API 作用域，只控制传输响应。 */
function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

it('saves and reloads the selected Profile rather than the current chat gateway', async () => {
  const gateway = new HermesGateway()
  const currentRequest = vi.spyOn(gateway, 'request').mockResolvedValue({})
  const scope = { connectionId: 'local', profile: 'work' }
  const { result } = renderHook(() => useMcpServers({ gateway, profile: scope }), { wrapper: Wrapper })
  await waitFor(() => expect(result.current.configLoading).toBe(false))

  await act(async () => {
    expect(await result.current.removeServer('echo')).toBe(true)
  })
  expect(api).toHaveBeenCalledWith(
    expect.objectContaining({
      path: '/api/mcp/servers',
      method: 'PUT',
      connectionId: 'local',
      profile: 'work',
      body: { servers: {} }
    })
  )
  await waitFor(() =>
    expect(routedRequest).toHaveBeenCalledWith('local', 'work', 'reload.mcp', { confirm: true }, undefined, undefined, {
      spawnPriority: 'foreground'
    })
  )
  expect(currentRequest).not.toHaveBeenCalled()
})

it('does not publish a late save or reload into the newly selected Profile', async () => {
  let finishSave!: (value: { ok: boolean }) => void

  const pending = new Promise<{ ok: boolean }>(resolve => {
    finishSave = resolve
  })

  api.mockImplementation(async (request: HermesApiRequest) => {
    if (request.method === 'PUT') {
      return pending
    }

    if (request.path === '/api/config') {
      return { mcp_servers: { echo: { command: request.profile, enabled: false } } }
    }

    return { entries: [] }
  })
  const gateway = new HermesGateway()

  const { result, rerender } = renderHook(
    ({ profile }: { profile: ProfileScope }) => useMcpServers({ gateway, profile }),
    { wrapper: Wrapper, initialProps: { profile: { connectionId: 'local', profile: 'work' } as ProfileScope } }
  )

  await waitFor(() => expect(result.current.servers.echo?.command).toBe('work'))
  let saved!: Promise<boolean>
  act(() => {
    saved = result.current.removeServer('echo')
  })
  rerender({ profile: { connectionId: 'local', profile: 'other' } })
  await waitFor(() => expect(result.current.servers.echo?.command).toBe('other'))
  await act(async () => {
    finishSave({ ok: true })
    expect(await saved).toBe(false)
  })
  expect(result.current.servers.echo.command).toBe('other')
  expect(routedRequest).not.toHaveBeenCalled()
})

it('reuses native add, JSON save, toggle, probe and removal while preserving other entries and the other Profile', async () => {
  const configs: Record<string, McpServers> = {
    work: { keeper: { command: 'keeper', enabled: false, timeout: 90 } },
    other: { custom: { command: 'other-profile', enabled: false } }
  }

  const other = structuredClone(configs.other)
  let failSave = false
  let probeError: string | undefined
  api.mockImplementation(async (request: HermesApiRequest) => {
    const profile = request.profile ?? 'default'

    if (request.method === 'PUT') {
      if (failSave) {
        throw new Error('fixture save failed')
      }

      // 夹具只处理原生 MCP PUT 的已知请求结构，不模拟控制器逻辑。
      configs[profile] = structuredClone((request.body as { servers: McpServers }).servers)

      return { ok: true }
    }

    if (request.path === '/api/config') {
      return { mcp_servers: structuredClone(configs[profile]) }
    }

    if (request.path === '/api/mcp/catalog') {
      return { entries: [] }
    }

    return { ok: !probeError, error: probeError, tools: [] }
  })
  const scope = { connectionId: 'local', profile: 'work' }
  const gateway = new HermesGateway()
  const hook = renderHook(() => useMcpServers({ gateway, profile: scope }), { wrapper: Wrapper })
  await waitFor(() => expect(hook.result.current.servers.keeper).toBeTruthy())
  const entry = { command: 'node', args: ['fixture'], env: { TOKEN: '${TOKEN}' }, timeout: 60 }
  await act(async () => {
    expect(await hook.result.current.addServerEntry('custom', entry)).toBe(true)
  })
  await waitFor(() => expect(hook.result.current.servers.custom).toEqual(entry))

  act(() =>
    hook.result.current.setDraft(
      JSON.stringify({ mcpServers: { ...hook.result.current.servers, custom: { ...entry, cwd: 'new-work' } } })
    )
  )
  await act(async () => {
    await hook.result.current.saveDoc()
  })
  expect(configs.work.custom).toEqual({ ...entry, cwd: 'new-work' })
  await act(async () => {
    await hook.result.current.setServerEnabled('custom', false)
  })
  expect(configs.work.custom.enabled).toBe(false)
  await act(async () => {
    await hook.result.current.setServerEnabled('custom', true)
  })
  expect(configs.work.custom.enabled).toBeUndefined()

  failSave = true
  await act(async () => {
    expect(await hook.result.current.removeServer('custom')).toBe(false)
  })
  expect(configs.work.custom).toBeTruthy()
  expect(notifyError).toHaveBeenCalledWith(expect.any(Error), 'Remove failed')
  probeError = 'Program not found'
  await act(async () => {
    await hook.result.current.runProbe('custom')
  })
  expect(hook.result.current.probes.custom).toEqual({ ok: false, error: probeError, tools: [] })
  failSave = false
  await act(async () => {
    expect(await hook.result.current.removeServer('custom')).toBe(true)
  })
  expect(configs.work).toEqual({ keeper: { command: 'keeper', enabled: false, timeout: 90 } })
  expect(configs.other).toEqual(other)
  hook.unmount()
  const reopened = renderHook(() => useMcpServers({ gateway, profile: scope }), { wrapper: Wrapper })
  await waitFor(() => expect(reopened.result.current.configLoading).toBe(false))
  expect(reopened.result.current.servers.custom).toBeUndefined()
  expect(api.mock.calls.every(([request]) => request.profile === 'work' && request.connectionId === 'local')).toBe(true)
})
