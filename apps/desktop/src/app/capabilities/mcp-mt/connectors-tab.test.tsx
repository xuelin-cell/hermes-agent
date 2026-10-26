import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { McpTestResult } from '@/hermes'
import type { McpServers } from '@/lib/mcp-servers'

import { DRIVE_MCP_MANAGED, DRIVE_MCP_SERVER } from '../../../../electron/login/drive-mcp-contract'
import type { McpServersController } from '../mcp/use-mcp-servers'

const { readController, listServers, readStatus } = vi.hoisted(() => ({
  readController: vi.fn(),
  listServers: vi.fn(),
  readStatus: vi.fn()
}))

vi.mock('../mcp/use-mcp-servers', () => ({ useMcpServers: readController }))
vi.mock('../connectors/data/rpc', () => ({ listMcpServers: listServers, mcpServerStatus: readStatus }))

const { McpConnectorsTab } = await import('./connectors-tab')

const TOOLKIT_URL = 'https://example.invalid/mcp?key=${DESKTOP_MT_MAAS_API_KEY}'

let saved: McpServers
let saves: { next: McpServers; reload: boolean }[]
let probe: ReturnType<typeof vi.fn<(name: string) => Promise<McpTestResult | null>>>
let removeServer: ReturnType<typeof vi.fn<(name: string) => Promise<boolean>>>
let overrides: Partial<McpServersController>
const scrollIntoView = vi.fn()

/** 受控的原生控制器替身：保存真的改写配置，便于观察页面写了什么。 */
function useFakeController(): McpServersController {
  const [servers, setServers] = useState<McpServers>(saved)

  const replaceServers: McpServersController['replaceServers'] = async (transform, reloadWhen) => {
    const next = transform(saved)
    saves.push({ next, reload: reloadWhen ? reloadWhen(saved, next) : true })
    saved = next
    setServers(next)

    return true
  }

  return {
    servers,
    statuses: Object.fromEntries(
      Object.keys(servers).map(name => [name, servers[name].enabled === false ? 'off' : 'ok'])
    ),
    probes: {
      alpha: {
        ok: true,
        tools: [
          { name: 'echo', description: '' },
          { name: 'ping', description: '' }
        ]
      }
    },
    toolCounts: {},
    configLoading: false,
    configFailed: false,
    profilePending: false,
    saving: false,
    authing: null,
    refetchConfig: vi.fn(),
    runProbe: probe,
    removeServer,
    authenticate: vi.fn(),
    replaceServers,
    ...overrides
  } as unknown as McpServersController
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
  scrollIntoView.mockReset()
  saved = {
    'UniAI-Toolkit': { url: TOOLKIT_URL, timeout: 600 },
    'arXiv-mcp': { url: 'https://arxiv.caseyjhand.com/mcp' },
    alpha: { command: 'node', args: ['server.js'], timeout: 90 },
    beta: { url: 'https://example.invalid/beta', enabled: false },
    connector_qcc_mcp: { desktop_connector: 'qcc_mcp', url: 'http://127.0.0.1:54190/mcp' },
    connector_wo_mail: { desktop_agent_mail: true, url: 'http://127.0.0.1:54887/mcp' }
  }
  saves = []
  overrides = {}
  probe = vi.fn(async () => ({ ok: true, tools: [{ name: 'echo', description: '' }] }))
  removeServer = vi.fn(async () => true)
  readController.mockImplementation(useFakeController)
  listServers.mockResolvedValue({
    servers: [{ name: 'helper__docs', source: 'plugin', plugin: 'helper', enabled: true, command: 'node', args: [] }]
  })
  readStatus.mockResolvedValue({ servers: [{ name: 'helper__docs', status: 'connected', tools: 3 }] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** 使用独立查询缓存渲染页面，不连接桌面运行实例。 */
function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/capabilities?tab=connectors']}>
        <McpConnectorsTab gateway={null} profile="work" scopeLabel="work" />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const row = (name: string) => screen.getByRole('article', { name })

it('lays out built-in, custom and plugin servers the UniWork way', async () => {
  renderTab()
  const builtIn = screen.getByRole('region', { name: 'Built-in MCP' })
  const toolkit = within(builtIn).getByRole('article', { name: 'UniAI-Toolkit' })
  expect(within(toolkit).getByText('Built-in')).toBeTruthy()
  expect(within(toolkit).queryByRole('button', { name: 'Remove UniAI-Toolkit?' })).toBeNull()
  fireEvent.click(within(toolkit).getByRole('button', { name: /^UniAI-Toolkit/ }))
  expect((within(toolkit).getByLabelText('URL') as HTMLInputElement).readOnly).toBe(true)
  const arxiv = within(builtIn).getByRole('article', { name: 'arXiv-mcp' })
  expect(within(arxiv).getByText('Built-in')).toBeTruthy()
  expect(within(arxiv).getByText('Search and retrieve arXiv papers for research and literature review.')).toBeTruthy()

  const custom = screen.getByRole('region', { name: 'Custom MCP Servers' })
  const alpha = within(custom).getByRole('article', { name: 'alpha' })
  expect(within(alpha).getByText('STDIO')).toBeTruthy()
  expect(within(alpha).getByText('node server.js')).toBeTruthy()
  expect(within(alpha).getByText('2 tools available')).toBeTruthy()
  expect(within(custom).getByRole('article', { name: 'beta' })).toBeTruthy()
  expect(within(custom).queryByRole('article', { name: 'connector_qcc_mcp' })).toBeNull()
  expect(within(custom).queryByRole('article', { name: 'connector_wo_mail' })).toBeNull()

  const plugin = await screen.findByRole('article', { name: 'helper__docs' })
  expect(within(plugin).queryByRole('switch')).toBeNull()
  expect(within(plugin).getByText('3 tools available')).toBeTruthy()
  expect(listServers).toHaveBeenCalledWith('work')
})

it('turns a server on only after its connection test passes', async () => {
  renderTab()
  fireEvent.click(within(row('beta')).getByRole('switch'))
  await waitFor(() => expect(saved.beta.enabled).toBeUndefined())
  expect(probe).toHaveBeenCalledWith('beta')
  expect(saves.at(-1)?.reload).toBe(true)

  probe.mockResolvedValue({ ok: false, error: 'Program not found', tools: [] })
  saved = { ...saved, beta: { ...saved.beta, enabled: false } }
  cleanup()
  renderTab()
  const beta = row('beta')
  fireEvent.click(within(beta).getByRole('switch'))
  expect(await within(beta).findByText('Failed')).toBeTruthy()
  expect(saved.beta.enabled).toBe(false)
  expect((within(beta).getByRole('switch') as HTMLButtonElement).getAttribute('aria-checked')).toBe('false')
  fireEvent.click(within(beta).getByRole('button', { name: /^beta/ }))
  expect(within(beta).getByRole('alert').textContent).toBe('Program not found')
})

it('turns an edited server off at once, then saves the form without losing hidden fields', async () => {
  renderTab()
  const alpha = row('alpha')
  fireEvent.click(within(alpha).getByRole('button', { name: /^alpha/ }))
  fireEvent.change(within(alpha).getByLabelText('Arguments (space-separated)'), {
    target: { value: 'server.js --port "8 0"' }
  })
  await waitFor(() => expect(saved.alpha.enabled).toBe(false))
  expect(saves[0].reload).toBe(true)
  await waitFor(() => expect(saved.alpha.args).toEqual(['server.js', '--port', '8 0']))
  expect(saved.alpha).toEqual({ command: 'node', args: ['server.js', '--port', '8 0'], timeout: 90, enabled: false })
  expect(saves.at(-1)?.reload).toBe(false)

  fireEvent.change(within(alpha).getByLabelText('Name'), { target: { value: 'renamed' } })
  await waitFor(() => expect(Object.keys(saved)).toEqual([
    'UniAI-Toolkit',
    'arXiv-mcp',
    'renamed',
    'beta',
    'connector_qcc_mcp',
    'connector_wo_mail'
  ]))
  expect(within(row('renamed')).getByLabelText('Name')).toBeTruthy()
})

it('adds a blank server that is only written once its name and address are filled in', async () => {
  renderTab()
  fireEvent.click(screen.getByRole('button', { name: 'Add MCP Server' }))
  fireEvent.click(screen.getByRole('button', { name: 'HTTP' }))
  const draft = row('Untitled server')
  const name = within(draft).getByLabelText('Name')
  expect(name).toBe(document.activeElement)
  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  fireEvent.change(name, { target: { value: 'beta' } })
  expect(within(draft).getByText('Another server already uses this name')).toBeTruthy()
  fireEvent.change(within(draft).getByLabelText('Name'), { target: { value: 'gamma' } })
  expect(within(draft).getByText('Enter a URL')).toBeTruthy()
  fireEvent.change(within(draft).getByLabelText('URL'), { target: { value: 'https://example.invalid/g' } })
  await waitFor(() => expect(saved.gamma).toEqual({ url: 'https://example.invalid/g', enabled: false }))
  expect(saves).toHaveLength(1)
  expect(within(row('gamma')).getByLabelText('URL')).toBeTruthy()
})

it('confirms before deleting and reports configuration failures', async () => {
  renderTab()
  fireEvent.click(within(row('beta')).getByRole('button', { name: 'Remove beta?' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  })
  expect(removeServer).toHaveBeenCalledWith('beta')

  cleanup()
  overrides = { configFailed: true }
  listServers.mockRejectedValue(new Error('fixture offline'))
  renderTab()
  expect(screen.getByText('Could not load MCP configuration')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Add MCP Server' })).toBeNull()
  expect(await screen.findByText('Could not load plugin MCP servers')).toBeTruthy()
})

it('受管网盘从 MCP 页面隐藏，同名自定义 MCP 和其他连接器仍可操作', () => {
  saved[DRIVE_MCP_SERVER] = { url: 'http://127.0.0.1:12345/mcp', uniwork_managed: DRIVE_MCP_MANAGED }
  renderTab()
  expect(screen.queryByRole('article', { name: DRIVE_MCP_SERVER })).toBeNull()
  expect(saved[DRIVE_MCP_SERVER].uniwork_managed).toBe(DRIVE_MCP_MANAGED)
  expect(within(row('alpha')).getByRole('switch')).toBeTruthy()
  cleanup()
  saved[DRIVE_MCP_SERVER] = { url: 'https://custom.invalid/mcp' }
  renderTab()
  expect(within(row(DRIVE_MCP_SERVER)).getByRole('switch')).toBeTruthy()
  expect(saves).toEqual([])
  expect(removeServer).not.toHaveBeenCalled()
})
