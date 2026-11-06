import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import type { AgentMailLocalStateStore } from '../agent-mail/local-state'
import type { LoginIdentity } from '../login/session'

import { CONNECTOR_SPECS } from './contract'
import { ConnectorManager } from './manager'
import { ConnectorRuntime } from './runtime'

beforeEach(() => {
  const starts = new WeakMap<ConnectorRuntime, Promise<void>>()
  // 与真实运行时相同：同一次启动返回同一个 Promise，防止邮箱初始化重复。
  vi.spyOn(ConnectorRuntime.prototype, 'start').mockImplementation(function (this: ConnectorRuntime) {
    if (!starts.has(this)) {starts.set(this, Promise.resolve())}

    return starts.get(this)!
  })
})

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
    api?: ConstructorParameters<typeof ConnectorManager>[0]['api']
    saveAttachment?: (name: string, download: () => Promise<Response>) => Promise<{ canceled: boolean; saved: boolean }>
    stageAttachment?: (name: string, download: () => Promise<Response>) => Promise<{ name: string; path: string }>
  } = {}
) {
  return new ConnectorManager({
    home,
    active: () => true,
    api: overrides.api ?? (async request => {
      if (request.method === 'PUT') {
        writes.push(request.body)
      }

      return saved
    }),
    openExternal: vi.fn(async () => undefined),
    saveAttachment: overrides.saveAttachment ?? vi.fn(async () => ({ canceled: false, saved: true })),
    stageAttachment: overrides.stageAttachment ?? vi.fn(async name => ({ name, path: `/tmp/${name}` })),
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

it('多个助手共用连接器和邮箱授权；配置仍按助手写入，旧授权目录保持原样', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-shared-connector-'))
  const profiles = ['default', 'expert-a', 'expert-b']
  const instances = new Set<ConnectorRuntime>()
  let mailbox = false

  const rows = vi.spyOn(ConnectorRuntime.prototype, 'rows').mockImplementation(async function (this: ConnectorRuntime) {
    instances.add(this)

    return [{ id: 'eastmoney_mcp', connected: true }]
  })

  vi.spyOn(ConnectorRuntime.prototype, 'connection').mockImplementation(async () =>
    mailbox ? { configured: true, displayName: '13800000000@wo.cn' } : null)
  vi.spyOn(ConnectorRuntime.prototype, 'request').mockImplementation(async () => { mailbox = true })
  vi.spyOn(ConnectorRuntime.prototype, 'config').mockImplementation(async function (this: ConnectorRuntime, id) {
    instances.add(this)

    return { url: `http://127.0.0.1:${12000 + [...instances].indexOf(this)}/mcp`,
      headers: { 'X-OpenConnector-Allowed-Services': id }, desktop_connector: id }
  })
  const close = vi.spyOn(ConnectorRuntime.prototype, 'close').mockResolvedValue()
  const api = vi.fn(async () => ({ mcp_servers: {} }))
  const exclusiveCode = vi.fn(async () => 'fixture-code')
  const manager = makeManager(home, {}, [], { exclusiveCode, api })

  try {
    for (const profile of profiles) {
      const target = profile === 'default' ? home : path.join(home, 'profiles', profile)
      fs.mkdirSync(path.join(target, 'open-connector'), { recursive: true })
      fs.writeFileSync(path.join(target, 'open-connector', 'old-data'), profile)
      fs.writeFileSync(path.join(target, 'config.yaml'), 'model: personal-model\n')
    }

    await Promise.all(profiles.map(profile => manager.prepare(profile)))
    expect(exclusiveCode).toHaveBeenCalledOnce()
    expect(instances.size).toBe(1)

    for (const profile of profiles) {
      const target = profile === 'default' ? home : path.join(home, 'profiles', profile)
      const saved = parse(fs.readFileSync(path.join(target, 'config.yaml'), 'utf8'))
      expect(saved.model).toBe('personal-model')
      expect(saved.mcp_servers.connector_eastmoney_mcp.url).toBe('http://127.0.0.1:12000/mcp')
      expect(saved.mcp_servers.connector_wo_mail.enabled).toBe(true)
      expect(fs.readFileSync(path.join(target, 'open-connector', 'old-data'), 'utf8')).toBe(profile)
    }

    await manager.request({ operation: 'list', profile: 'expert-a' })
    expect(rows).toHaveBeenCalledTimes(4)
    expect(instances.size).toBe(1)
    expect(api).toHaveBeenCalledWith(expect.objectContaining({ profile: 'expert-a', method: 'PUT' }))
  } finally {
    await manager.close()
    expect(close).toHaveBeenCalledOnce()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('自动申请失败不随专家重复；重启可再申请，手动开通后各专家读取新授权', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mail-once-'))
  fs.mkdirSync(path.join(home, 'profiles', 'expert'), { recursive: true })
  fs.writeFileSync(path.join(home, 'config.yaml'), '{}\n')
  fs.writeFileSync(path.join(home, 'profiles', 'expert', 'config.yaml'), '{}\n')
  vi.spyOn(ConnectorRuntime.prototype, 'rows').mockResolvedValue([])
  let mailbox = false
  vi.spyOn(ConnectorRuntime.prototype, 'connection').mockImplementation(async () =>
    mailbox ? { configured: true, displayName: '13800000000@wo.cn' } : null)
  vi.spyOn(ConnectorRuntime.prototype, 'request').mockImplementation(async () => { mailbox = true })
  vi.spyOn(ConnectorRuntime.prototype, 'config').mockResolvedValue({ url: 'http://127.0.0.1:1234/mcp' })
  vi.spyOn(ConnectorRuntime.prototype, 'close').mockResolvedValue()
  const exclusiveCode = vi.fn(async (): Promise<string> => { throw new Error('fixture rejection') })
  const manager = makeManager(home, {}, [], { exclusiveCode })

  try {
    for (const profile of ['default', 'expert', 'default']) {
      await expect(manager.prepare(profile)).resolves.toBeUndefined()
    }

    expect(exclusiveCode).toHaveBeenCalledOnce()
    const file = path.join(home, 'profiles', 'expert', 'config.yaml')
    expect(parse(fs.readFileSync(file, 'utf8')).mcp_servers.connector_wo_mail.enabled).toBe(false)
    vi.mocked(ConnectorRuntime.prototype.start).mockReturnValue(Promise.resolve())
    await expect(manager.prepare('expert')).resolves.toBeUndefined()
    expect(exclusiveCode).toHaveBeenCalledTimes(2)

    exclusiveCode.mockResolvedValue('fixture-manual-code')
    await manager.agentMail({ operation: 'enable', profile: 'default' })
    await manager.prepare('expert')
    expect(parse(fs.readFileSync(file, 'utf8')).mcp_servers.connector_wo_mail.enabled).toBe(true)
    expect(exclusiveCode).toHaveBeenCalledTimes(3)
  } finally {
    await manager.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('运行中刷新连接器和邮箱只走配置接口，保留自定义邮箱条目和关闭偏好', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-connector-refresh-'))
  const file = path.join(home, 'config.yaml')
  fs.writeFileSync(file, '# running backend owns this file\n')
  vi.spyOn(ConnectorRuntime.prototype, 'rows').mockResolvedValue([{ id: 'amap', connected: true }])
  vi.spyOn(ConnectorRuntime.prototype, 'connection').mockResolvedValue({ configured: true, displayName: '13800000000@wo.cn' })
  vi.spyOn(ConnectorRuntime.prototype, 'config').mockImplementation(async id => ({
    url: 'http://127.0.0.1:1234/mcp', desktop_connector: id
  }))
  vi.spyOn(ConnectorRuntime.prototype, 'close').mockResolvedValue()
  const writes: any[] = []
  const saved: any = { mcp_servers: {} }
  const mailState = { get: vi.fn(() => ({ email: '13800000000@wo.cn', enabled: false })), save: vi.fn() }
  const manager = makeManager(home, saved, writes, { mailState })

  try {
    await manager.refresh('default')
    expect(writes).toHaveLength(2)
    expect(writes[1].config.mcp_servers.connector_wo_mail).toMatchObject({ enabled: false, desktop_agent_mail: true })
    writes.length = 0
    saved.mcp_servers.connector_wo_mail = { url: 'https://personal.example/mcp' }
    await manager.refresh('default')
    expect(writes).toHaveLength(1)
    expect(writes[0].config.mcp_servers.connector_wo_mail).toBeUndefined()
    expect(fs.readFileSync(file, 'utf8')).toBe('# running backend owns this file\n')
  } finally {
    await manager.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

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

it('starts WPS browser-poll authorization and mounts it after the local runtime connects', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-wps-browser-auth-'))
  const writes: unknown[] = []
  let connected = false

  const request = vi.spyOn(ConnectorRuntime.prototype, 'request').mockResolvedValue({
    authorizationUrl: 'https://mcp-center.wps.cn/kdocs-auth/auth-guide?auth_code=test'
  })

  vi.spyOn(ConnectorRuntime.prototype, 'rows').mockImplementation(async () => [{ id: 'wps_mcp', connected }])
  vi.spyOn(ConnectorRuntime.prototype, 'config').mockResolvedValue({
    url: 'http://127.0.0.1:1234/mcp',
    headers: { Authorization: 'Bearer runtime' },
    desktop_connector: 'wps_mcp',
    timeout: 600
  })
  vi.spyOn(ConnectorRuntime.prototype, 'close').mockResolvedValue()
  const manager = makeManager(home, { mcp_servers: {} }, writes)

  try {
    vi.useFakeTimers()
    await manager.request({ operation: 'authorize', profile: 'default', id: 'wps_mcp' })
    expect(request).toHaveBeenCalledWith('/api/browser-authorizations/wps_mcp', 'POST', {
      service: 'wps_mcp',
      connectionName: 'default'
    })
    connected = true
    await vi.advanceTimersByTimeAsync(2000)
    expect(writes).toHaveLength(1)
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
    .mockResolvedValue({ configured: true, displayName: '13800000000@wo.cn' })
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
    .mockResolvedValue({ configured: true, displayName: '13800000000@wo.cn' })
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

it('refreshes an expired cached exclusive code before rebuilding the mailbox connection', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-mail-refresh-'))
  fs.writeFileSync(path.join(home, 'config.yaml'), '{}\n')
  const writes: unknown[] = []

  const request = vi.spyOn(ConnectorRuntime.prototype, 'request')
    .mockRejectedValueOnce(new Error('credential verification failed'))
    .mockResolvedValueOnce({})

  vi.spyOn(ConnectorRuntime.prototype, 'rows').mockResolvedValue([])
  vi.spyOn(ConnectorRuntime.prototype, 'connection')
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ configured: true, displayName: '13800000000@wo.cn' })
  vi.spyOn(ConnectorRuntime.prototype, 'config').mockResolvedValue({
    url: 'http://127.0.0.1:1234/mcp',
    headers: { Authorization: 'Bearer runtime' }
  })
  vi.spyOn(ConnectorRuntime.prototype, 'close').mockResolvedValue()

  const mailState = {
    get: vi.fn(() => ({ authorizationCode: 'expired-mail-code', email: '13800000000@wo.cn', enabled: true })),
    save: vi.fn()
  }

  const exclusiveCode = vi.fn(async () => 'fresh-mail-code')
  const manager = makeManager(home, { mcp_servers: {} }, writes, { mailState, exclusiveCode })

  try {
    await manager.prepare('default')

    expect(exclusiveCode).toHaveBeenCalledOnce()
    expect(request).toHaveBeenNthCalledWith(1, '/api/connections/wo_mail', 'PUT', {
      authType: 'custom_credential',
      connectionName: 'default',
      values: { authorizationCode: 'expired-mail-code', email: '13800000000@wo.cn' }
    })
    expect(request).toHaveBeenNthCalledWith(2, '/api/connections/wo_mail', 'PUT', {
      authType: 'custom_credential',
      connectionName: 'default',
      values: { authorizationCode: 'fresh-mail-code', email: '13800000000@wo.cn' }
    })
    expect(mailState.save).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ uid: 'account-a', phone: '13800000000' }),
      { email: '13800000000@wo.cn', enabled: true }
    )
    expect(mailState.save).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'account-a', phone: '13800000000' }),
      expect.objectContaining({ authorizationCode: 'fresh-mail-code', enabled: true, email: '13800000000@wo.cn' })
    )
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

it('stages a mail attachment through the main-process owner for the composer', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-mail-stage-'))
  const writes: unknown[] = []
  const saved = { mcp_servers: { connector_wo_mail: { desktop_agent_mail: true, enabled: true } } }

  const stageAttachment = vi.fn(async (name: string, download: () => Promise<Response>) => {
    const response = await download()
    expect(await response.text()).toBe('attachment body')

    return { name, path: `/tmp/${name}` }
  })

  const request = vi.spyOn(ConnectorRuntime.prototype, 'request').mockResolvedValue({
    success: true,
    data: { file: { downloadUrl: 'http://127.0.0.1:1234/api/files/a', name: 'report.md' } }
  })

  vi.spyOn(ConnectorRuntime.prototype, 'download').mockResolvedValue(new Response('attachment body'))
  vi.spyOn(ConnectorRuntime.prototype, 'connection').mockResolvedValue({
    configured: true,
    displayName: '13800000000@wo.cn'
  })
  vi.spyOn(ConnectorRuntime.prototype, 'close').mockResolvedValue()
  const manager = makeManager(home, saved, writes, { stageAttachment })

  try {
    await expect(
      manager.agentMail({
        operation: 'action',
        profile: 'default',
        action: 'stage_attachment',
        input: { attachmentId: '2', folder: 'INBOX', uid: 8 }
      })
    ).resolves.toMatchObject({ data: { file: { name: 'report.md', path: '/tmp/report.md' } } })
    expect(request).toHaveBeenCalledWith('/v1/actions/wo_mail.download_attachment', 'POST', {
      connectionName: 'default',
      input: { attachmentId: '2', folder: 'INBOX', uid: 8 }
    })
    expect(stageAttachment).toHaveBeenCalledWith('report.md', expect.any(Function))
  } finally {
    await manager.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
