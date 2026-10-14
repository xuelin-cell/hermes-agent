import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { McpServersController } from '../mcp/use-mcp-servers'

const { readController, listServers, readStatus, probe, toggle } = vi.hoisted(() => ({
  readController: vi.fn(),
  listServers: vi.fn(),
  readStatus: vi.fn(),
  probe: vi.fn(),
  toggle: vi.fn()
}))

vi.mock('../mcp/use-mcp-servers', () => ({ useMcpServers: readController }))
vi.mock('../connectors/data/rpc', () => ({
  listMcpServers: listServers,
  mcpServerStatus: readStatus,
  setMcpBearerToken: vi.fn()
}))
vi.mock('../mcp/mcp-editor', () => ({
  McpJsonEditor: ({ highlightServer }: { highlightServer: string }) => <div>JSON: {highlightServer}</div>
}))
vi.mock('../connectors/tools-panel', () => ({ LocalToolsPanel: () => <div>native tool filters</div> }))
vi.mock('../connectors/plugin-tools-panel', () => ({ PluginToolsPanel: () => <div>native plugin tools</div> }))

const { McpConnectorsTab } = await import('./connectors-tab')
let controller: McpServersController

beforeEach(() => {
  controller = {
    servers: {
      alpha: { command: 'node', args: ['--secret-do-not-display'] },
      beta: { url: 'https://example.invalid/mcp', enabled: false }
    },
    statuses: { alpha: 'ok', beta: 'off' },
    catalog: [
      { name: 'alpha', connector_slug: 'shared' },
      { name: 'beta', connector_slug: 'shared' }
    ],
    probes: { alpha: { ok: true, tools: [{ name: 'echo', description: '' }] } },
    toolCounts: {},
    usageByServer: {},
    runProbe: probe,
    setServerEnabled: toggle,
    configLoading: false,
    configFailed: false,
    profilePending: false,
    saving: false,
    refetchConfig: vi.fn(),
    blocks: [],
    draft: '{}',
    names: ['alpha', 'beta'],
    removeServer: vi.fn(),
    authing: null,
    setServerTools: vi.fn(),
    addServerEntry: vi.fn(),
    resetDraft: vi.fn()
  } as unknown as McpServersController
  readController.mockImplementation(() => controller)
  listServers.mockResolvedValue({
    servers: [
      {
        name: 'plugin__helper',
        source: 'plugin',
        plugin: 'helper',
        enabled: true,
        command: 'node',
        args: [],
        transport: 'stdio',
        url: null
      }
    ]
  })
  readStatus.mockResolvedValue({ servers: [{ name: 'plugin__helper', status: 'connected', tools: 1 }] })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** 使用原生页面组件与独立查询缓存，不连接桌面用户运行实例。 */
function renderTab(route = '/capabilities?tab=connectors') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <McpConnectorsTab gateway={null} profile="work" scopeLabel="work" />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

it('keeps every custom service and plugin ownership, and delegates row controls to native MCP', async () => {
  renderTab('/capabilities?tab=connectors&server=alpha&tool=echo')
  const custom = screen.getByRole('region', { name: 'Custom MCP' })
  const alpha = within(custom).getByRole('article', { name: 'alpha' })
  expect(within(custom).getByRole('article', { name: 'beta' })).toBeTruthy()
  expect(within(alpha).getByText('Last connection test passed')).toBeTruthy()
  expect(screen.queryByText(/secret-do-not-display/)).toBeNull()
  expect((screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(within(alpha).getByRole('switch'))
  expect(toggle).toHaveBeenCalledWith('alpha', false)
  expect(within(alpha).getByRole('button', { name: 'alpha' }).getAttribute('aria-expanded')).toBe('true')
  expect(within(alpha).getByText('native tool filters')).toBeTruthy()
  fireEvent.click(within(alpha).getByRole('button', { name: 'Configuration (JSON)' }))
  expect(within(alpha).getByText('JSON: alpha')).toBeTruthy()
  fireEvent.click(within(alpha).getByRole('button', { name: 'Test connection' }))
  expect(probe).toHaveBeenCalledWith('alpha')
  const plugin = await screen.findByRole('article', { name: 'plugin__helper' })
  expect(within(plugin).queryByRole('switch')).toBeNull()
  expect(within(plugin).queryByRole('button', { name: /Remove/ })).toBeNull()
  fireEvent.click(within(plugin).getByRole('button', { name: 'plugin__helper' }))
  expect(within(plugin).getByText('native plugin tools')).toBeTruthy()
  expect(listServers).toHaveBeenCalledWith('work')
  expect(readStatus).toHaveBeenCalledWith('work')
})

it('reports configuration and plugin failures without enabling writes or claiming an empty configuration', async () => {
  controller.configFailed = true
  listServers.mockRejectedValue(new Error('fixture offline'))
  renderTab()
  expect(screen.getByText('Could not load MCP configuration')).toBeTruthy()
  expect(screen.queryByText('No custom MCP servers')).toBeNull()
  expect((screen.getByRole('button', { name: 'Add custom MCP' }) as HTMLButtonElement).disabled).toBe(true)
  expect(await screen.findByText('Could not load plugin MCP servers')).toBeTruthy()
  const custom = screen.getByRole('region', { name: 'Custom MCP' })
  fireEvent.click(within(custom).getByRole('button', { name: 'Retry' }))
  expect(controller.refetchConfig).toHaveBeenCalledOnce()
})
