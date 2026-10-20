import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { ConnectorManager } from './manager'
import { CONNECTOR_SPECS } from './contract'
import { ConnectorRuntime } from './runtime'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function makeManager(home: string, saved: Record<string, any>, writes: unknown[]) {
  return new ConnectorManager({
    home,
    active: () => true,
    api: async request => {
      if (request.method === 'PUT') {
        writes.push(request.body)
      }

      return saved
    },
    openExternal: vi.fn(async () => undefined),
    runtimeDirectory: 'unused',
    executable: 'unused',
    encrypt: value => Buffer.from(value),
    decrypt: value => value.toString()
  })
}

it('mounts an OAuth connector after browser authorization completes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-connector-manager-'))
  const writes: unknown[] = []
  let connected = false
  vi.spyOn(ConnectorRuntime.prototype, 'request').mockResolvedValue({
    authorizationUrl: 'https://example.test/oauth'
  })
  vi.spyOn(ConnectorRuntime.prototype, 'rows').mockImplementation(async () => [{ id: 'qcc_mcp', connected }])
  vi.spyOn(ConnectorRuntime.prototype, 'config').mockResolvedValue({
    url: 'http://127.0.0.1:1234/mcp',
    headers: { Authorization: 'Bearer runtime' },
    desktop_connector: 'qcc_mcp',
    timeout: 600
  })
  vi.spyOn(ConnectorRuntime.prototype, 'close').mockResolvedValue()
  const manager = makeManager(home, { mcp_servers: {} }, writes)

  try {
    vi.useFakeTimers()
    await manager.request({ operation: 'authorize', profile: 'default', id: 'qcc_mcp' })
    expect(writes).toEqual([])
    connected = true
    await vi.advanceTimersByTimeAsync(2000)
    expect(writes).toEqual([
      {
        config: {
          mcp_servers: {
            connector_qcc_mcp: {
              url: 'http://127.0.0.1:1234/mcp',
              headers: { Authorization: 'Bearer runtime' },
              desktop_connector: 'qcc_mcp',
              timeout: 600,
              enabled: true
            }
          }
        }
      }
    ])
  } finally {
    await manager.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('does not overwrite a user-owned MCP name claimed while OAuth is open', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-connector-collision-'))
  const writes: unknown[] = []
  let connected = false
  const saved: Record<string, any> = { mcp_servers: {} }
  vi.spyOn(ConnectorRuntime.prototype, 'request').mockResolvedValue({
    authorizationUrl: 'https://example.test/oauth'
  })
  vi.spyOn(ConnectorRuntime.prototype, 'rows').mockImplementation(async () => [{ id: 'qcc_mcp', connected }])
  vi.spyOn(ConnectorRuntime.prototype, 'config').mockResolvedValue({})
  vi.spyOn(ConnectorRuntime.prototype, 'close').mockResolvedValue()
  const manager = makeManager(home, saved, writes)

  try {
    vi.useFakeTimers()
    await manager.request({ operation: 'authorize', profile: 'default', id: 'qcc_mcp' })
    saved.mcp_servers.connector_qcc_mcp = { url: 'https://user.example/mcp' }
    connected = true
    await vi.advanceTimersByTimeAsync(2000)
    expect(writes).toEqual([])
  } finally {
    await manager.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('keeps Wo Mail out of the connector catalogue while serving it through Agent Mail', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-mail-'))
  const writes: unknown[] = []
  const saved = { mcp_servers: { connector_wo_mail: { desktop_agent_mail: true, enabled: true } } }
  const request = vi.spyOn(ConnectorRuntime.prototype, 'request').mockResolvedValue({
    success: true,
    data: { folders: [{ path: 'INBOX', specialUse: '\\Inbox' }] }
  })
  vi.spyOn(ConnectorRuntime.prototype, 'connection').mockResolvedValue({
    configured: true,
    displayName: '13800000000@wo.cn'
  })
  vi.spyOn(ConnectorRuntime.prototype, 'close').mockResolvedValue()
  const manager = makeManager(home, saved, writes)

  try {
    expect(Object.hasOwn(CONNECTOR_SPECS, 'wo_mail')).toBe(false)
    await expect(
      manager.agentMail({ operation: 'action', profile: 'default', action: 'list_folders', input: {} }, '13800000000')
    ).resolves.toMatchObject({
      data: { folders: [{ path: 'INBOX', specialUse: '\\Inbox' }] },
      status: { email: '13800000000@wo.cn', enabled: true }
    })
    expect(request).toHaveBeenCalledWith('/v1/actions/wo_mail.list_folders', 'POST', {
      connectionName: 'default',
      input: {}
    })
    expect(writes).toEqual([])
  } finally {
    await manager.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
