import { afterEach, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn<(channel: string, request: unknown) => Promise<unknown>>()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: host.exposeInMainWorld },
  ipcRenderer: { invoke: host.invoke, sendSync: vi.fn(() => ({})) },
  webFrame: {},
  webUtils: {}
}))

interface ApiRequest {
  path: string
  method?: string
  profile: string
  connectionId: string
  body?: unknown
}

/** 加载真实 preload 接线，只有 Electron IPC 响应受控。 */
async function loadBridge(): Promise<{ api: (request: ApiRequest) => Promise<unknown> }> {
  await import('./preload')

  return host.exposeInMainWorld.mock.calls.at(-1)![1]
}

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

const record = { mcp_servers: { x: { url: 'https://example.invalid/mcp?key=sk-0123456789abcdefTAIL' } } }
const scope = { profile: 'work', connectionId: 'local-account' }

it('masks before crossing into the page and restores before IPC while keeping request scope', async () => {
  const bridge = await loadBridge()
  host.invoke.mockResolvedValueOnce(record)
  const masked = await bridge.api({ path: '/api/config', ...scope })

  expect(JSON.stringify(masked)).not.toContain('sk-0123456789abcdefTAIL')
  expect(host.invoke).toHaveBeenLastCalledWith('hermes:api', { path: '/api/config', ...scope, body: undefined })
  host.invoke.mockResolvedValueOnce({ ok: true })
  await bridge.api({ path: '/api/config', method: 'PUT', ...scope, body: { config: masked } })
  expect(host.invoke).toHaveBeenLastCalledWith('hermes:api', {
    path: '/api/config',
    method: 'PUT',
    ...scope,
    body: { config: record }
  })
})

it('does not share masks with a fresh window or dispatch a save containing an unknown mask', async () => {
  const first = await loadBridge()
  host.invoke.mockResolvedValueOnce(record)
  const masked = await first.api({ path: '/api/config', ...scope })
  vi.resetModules()
  const second = await loadBridge()
  host.invoke.mockClear()

  await expect(second.api({ path: '/api/config', method: 'PUT', ...scope, body: { config: masked } })).rejects.toThrow(
    'MCP 密钥打码值已过期，请重新读取配置后再保存。'
  )
  expect(host.invoke).not.toHaveBeenCalled()
})
