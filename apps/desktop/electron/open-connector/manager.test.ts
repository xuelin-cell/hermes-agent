import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import type { AgentMailLocalStateStore } from '../agent-mail/local-state'
import type { LoginIdentity } from '../login/session'

import { CONNECTOR_SPECS } from './contract'
import { ConnectorManager } from './manager'
import { ConnectorRuntime } from './runtime'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function makeManager(
  home: string,
  saved: Record<string, any>,
  writes: unknown[],
  overrides: {
    mailState?: Pick<AgentMailLocalStateStore, 'get' | 'save'>
    exclusiveCode?: (phone: string) => Promise<string>
    identity?: () => LoginIdentity | null
    saveAttachment?: (name: string, download: () => Promise<Response>) => Promise<{ canceled: boolean; saved: boolean }>
  } = {}
) {
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
    saveAttachment: overrides.saveAttachment ?? vi.fn(async () => ({ canceled: false, saved: true })),
    log: vi.fn(),
    identity:
      overrides.identity ??
      (() => ({
        uid: 'account-a',
        token: 'token-a',
        phone: '13800000000',
        maskedPhone: '138****0000',
        expiresAt: Date.now() + 60_000
      })),
    mailState: overrides.mailState ?? { get: vi.fn(() => null), save: vi.fn() },
    exclusiveCode: overrides.exclusiveCode,
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

  const manager = makeManager(
    home,
    { mcp_servers: { connector_qcc_mcp: { desktop_connector: 'qcc_mcp', enabled: false } } },
    writes
  )

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

it('automatically provisions Agent Mail for a newly logged-in phone account', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-mail-auto-'))
  fs.writeFileSync(path.join(home, 'config.yaml'), '{}\n')
  const writes: unknown[] = []
  const request = vi.spyOn(ConnectorRuntime.prototype, 'request').mockResolvedValue({})
  vi.spyOn(ConnectorRuntime.prototype, 'rows').mockResolvedValue([])
  vi.spyOn(ConnectorRuntime.prototype, 'connection')
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ configured: true, displayName: '13800000000@wo.cn' })
  vi.spyOn(ConnectorRuntime.prototype, 'config').mockResolvedValue({
    url: 'http://127.0.0.1:1234/mcp',
    headers: { Authorization: 'Bearer runtime' }
  })
  vi.spyOn(ConnectorRuntime.prototype, 'close').mockResolvedValue()

  const mailState = { get: vi.fn(() => null), save: vi.fn() }

  const exclusiveCode = vi.fn(async () => 'mail-code')
  const manager = makeManager(home, { mcp_servers: {} }, writes, { mailState, exclusiveCode })

  try {
    await manager.prepare('default')

    expect(exclusiveCode).toHaveBeenCalledWith('13800000000')
    expect(request).toHaveBeenCalledWith('/api/connections/wo_mail', 'PUT', {
      authType: 'custom_credential',
      connectionName: 'default',
      values: { authorizationCode: 'mail-code', email: '13800000000@wo.cn' }
    })
    expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).toMatch(
      /connector_wo_mail:[\s\S]*desktop_agent_mail: true[\s\S]*enabled: true/
    )
    expect(mailState.save).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'account-a', phone: '13800000000' }),
      expect.objectContaining({ authorizationCode: 'mail-code', enabled: true, email: '13800000000@wo.cn' })
    )
  } finally {
    await manager.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('restores a disabled local state without requesting a new mailbox password', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-mail-disabled-'))
  fs.writeFileSync(
    path.join(home, 'config.yaml'),
    'mcp_servers:\n  connector_wo_mail:\n    desktop_agent_mail: true\n    enabled: true\n'
  )
  const writes: unknown[] = []
  vi.spyOn(ConnectorRuntime.prototype, 'rows').mockResolvedValue([])
  vi.spyOn(ConnectorRuntime.prototype, 'connection').mockResolvedValue({
    configured: true,
    displayName: '13800000000@wo.cn'
  })
  vi.spyOn(ConnectorRuntime.prototype, 'config').mockResolvedValue({
    url: 'http://127.0.0.1:1234/mcp',
    headers: { Authorization: 'Bearer runtime' }
  })
  vi.spyOn(ConnectorRuntime.prototype, 'close').mockResolvedValue()

  const mailState = { get: vi.fn(() => ({ email: '13800000000@wo.cn', enabled: false })), save: vi.fn() }

  const exclusiveCode = vi.fn(async () => 'unused')
  const manager = makeManager(home, { mcp_servers: {} }, writes, { mailState, exclusiveCode })

  try {
    await manager.prepare('default')

    expect(exclusiveCode).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).toMatch(/connector_wo_mail:[\s\S]*enabled: false/)
  } finally {
    await manager.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('reuses a restored same-phone mailbox without requesting another exclusive code', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-mail-restored-'))
  fs.writeFileSync(path.join(home, 'config.yaml'), '{}\n')
  const writes: unknown[] = []
  const request = vi.spyOn(ConnectorRuntime.prototype, 'request').mockResolvedValue({})
  vi.spyOn(ConnectorRuntime.prototype, 'rows').mockResolvedValue([])
  vi.spyOn(ConnectorRuntime.prototype, 'connection').mockResolvedValue({
    configured: true,
    displayName: '13800000000@wo.cn'
  })
  vi.spyOn(ConnectorRuntime.prototype, 'config').mockResolvedValue({
    url: 'http://127.0.0.1:1234/mcp',
    headers: { Authorization: 'Bearer runtime' }
  })
  vi.spyOn(ConnectorRuntime.prototype, 'close').mockResolvedValue()
  const exclusiveCode = vi.fn(async () => 'unused')
  const manager = makeManager(home, { mcp_servers: {} }, writes, { exclusiveCode })

  try {
    await manager.prepare('default')

    expect(exclusiveCode).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalledWith('/api/connections/wo_mail', 'PUT', expect.anything())
    expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).toMatch(
      /connector_wo_mail:[\s\S]*desktop_agent_mail: true[\s\S]*enabled: true/
    )
  } finally {
    await manager.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('rebuilds a missing mailbox connection from local state without contacting Wo Mail', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-mail-local-restore-'))
  fs.writeFileSync(path.join(home, 'config.yaml'), '{}\n')
  const writes: unknown[] = []
  const request = vi.spyOn(ConnectorRuntime.prototype, 'request').mockResolvedValue({})
  vi.spyOn(ConnectorRuntime.prototype, 'rows').mockResolvedValue([])
  vi.spyOn(ConnectorRuntime.prototype, 'connection')
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ configured: true, displayName: '13800000000@wo.cn' })
  vi.spyOn(ConnectorRuntime.prototype, 'config').mockResolvedValue({
    url: 'http://127.0.0.1:1234/mcp',
    headers: { Authorization: 'Bearer runtime' }
  })
  vi.spyOn(ConnectorRuntime.prototype, 'close').mockResolvedValue()

  const mailState = {
    get: vi.fn(() => ({ authorizationCode: 'saved-mail-code', email: '13800000000@wo.cn', enabled: true })),
    save: vi.fn()
  }

  const exclusiveCode = vi.fn(async () => 'should-not-be-requested')
  const manager = makeManager(home, { mcp_servers: {} }, writes, { mailState, exclusiveCode })

  try {
    await manager.prepare('default')

    expect(exclusiveCode).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith('/api/connections/wo_mail', 'PUT', {
      authType: 'custom_credential',
      connectionName: 'default',
      values: { authorizationCode: 'saved-mail-code', email: '13800000000@wo.cn' }
    })
  } finally {
    await manager.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('removes a mailbox connection that belongs to the previous phone account', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-mail-switch-'))
  fs.writeFileSync(
    path.join(home, 'config.yaml'),
    'mcp_servers:\n  connector_wo_mail:\n    desktop_agent_mail: true\n    enabled: true\n'
  )
  const writes: unknown[] = []
  const request = vi.spyOn(ConnectorRuntime.prototype, 'request').mockResolvedValue({})
  vi.spyOn(ConnectorRuntime.prototype, 'rows').mockResolvedValue([])
  vi.spyOn(ConnectorRuntime.prototype, 'connection').mockResolvedValue({
    configured: true,
    displayName: '13900000000@wo.cn'
  })
  vi.spyOn(ConnectorRuntime.prototype, 'config').mockResolvedValue({
    url: 'http://127.0.0.1:1234/mcp',
    headers: { Authorization: 'Bearer runtime' }
  })
  vi.spyOn(ConnectorRuntime.prototype, 'close').mockResolvedValue()

  const mailState = { get: vi.fn(() => ({ email: '13800000000@wo.cn', enabled: false })), save: vi.fn() }

  const exclusiveCode = vi.fn(async () => 'unused')
  const manager = makeManager(home, { mcp_servers: {} }, writes, { mailState, exclusiveCode })

  try {
    await manager.prepare('default')

    expect(request).toHaveBeenCalledWith('/api/connections/wo_mail', 'DELETE')
    expect(exclusiveCode).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).toMatch(/connector_wo_mail:[\s\S]*enabled: false/)
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
      manager.agentMail({ operation: 'action', profile: 'default', action: 'list_folders', input: {} })
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

it('keeps attachment download URLs in the main process and delegates the save to the native owner', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-mail-save-'))
  const writes: unknown[] = []
  const saved = { mcp_servers: { connector_wo_mail: { desktop_agent_mail: true, enabled: true } } }
  const saveAttachment = vi.fn(async (_name: string, download: () => Promise<Response>) => {
    const response = await download()
    expect(await response.text()).toBe('attachment body')
    return { canceled: false, saved: true }
  })

  vi.spyOn(ConnectorRuntime.prototype, 'request').mockResolvedValue({
    success: true,
    data: { file: { downloadUrl: 'http://127.0.0.1:1234/api/files/a', name: 'report.md' } }
  })
  vi.spyOn(ConnectorRuntime.prototype, 'download').mockResolvedValue(new Response('attachment body'))
  vi.spyOn(ConnectorRuntime.prototype, 'connection').mockResolvedValue({
    configured: true,
    displayName: '13800000000@wo.cn'
  })
  vi.spyOn(ConnectorRuntime.prototype, 'close').mockResolvedValue()
  const manager = makeManager(home, saved, writes, { saveAttachment })

  try {
    await expect(
      manager.agentMail({
        operation: 'action',
        profile: 'default',
        action: 'download_attachment',
        input: { attachmentId: '2', folder: 'INBOX', uid: 8 }
      })
    ).resolves.toMatchObject({ data: { canceled: false, saved: true } })
    expect(saveAttachment).toHaveBeenCalledWith('report.md', expect.any(Function))
  } finally {
    await manager.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
