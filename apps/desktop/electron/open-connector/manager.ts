import path from 'node:path'

import type { AgentMailAction, AgentMailRequest, AgentMailResult, AgentMailStatus } from '../agent-mail/contract'
import { fetchWoMailExclusiveCode } from '../agent-mail/exclusive-code'

import { connectorHome, prepareAgentMailConfig, prepareConnectorConfig } from './config'
import { CONNECTOR_SPECS, type LocalConnectorRequest, type LocalConnectorResult } from './contract'
import { ConnectorRuntime, type ConnectorRuntimeOptions } from './runtime'
import { WecomQrSessions } from './wecom-qr'

interface ConnectorManagerOptions extends Omit<ConnectorRuntimeOptions, 'directory'> {
  home: string
  active: () => boolean
  api: (request: {
    connectionId: string
    profile: string
    path: string
    method?: string
    body?: unknown
  }) => Promise<any>
  openExternal: (url: string) => Promise<void>
}

const AGENT_MAIL_ACTIONS: ReadonlySet<AgentMailAction> = new Set([
  'delete_email',
  'get_email',
  'get_folder_status',
  'list_folders',
  'mark_email_read',
  'search_emails'
])

/** Credentials stay in OpenConnector; Hermes owns the corresponding MCP settings. */
export class ConnectorManager {
  private runtimes = new Map<string, ConnectorRuntime>()
  private queues = new Map<string, Promise<unknown>>()
  private authorizationWatches = new Map<string, { generation: number; timer: NodeJS.Timeout }>()
  private authorizationGeneration = 0
  private closed = false
  private qr = new WecomQrSessions()

  constructor(private readonly options: ConnectorManagerOptions) {}

  private runtime(profile: string): ConnectorRuntime {
    if (this.closed || !this.options.active()) {
      throw new Error('Connector account is no longer active')
    }

    const home = connectorHome(this.options.home, profile)
    let runtime = this.runtimes.get(profile)

    if (!runtime) {
      runtime = new ConnectorRuntime({ ...this.options, directory: path.join(home, 'open-connector') })
      this.runtimes.set(profile, runtime)
    }

    return runtime
  }

  async prepare(profile: string): Promise<void> {
    const home = connectorHome(this.options.home, profile)
    const runtime = this.runtime(profile)
    const rows = await runtime.rows()
    await prepareConnectorConfig(
      home,
      rows.filter(row => row.connected).map(row => row.id),
      id => runtime.config(id)
    )
    await prepareAgentMailConfig(home, Boolean(await runtime.connection('wo_mail')), () => runtime.config('wo_mail'))
  }

  private authorizationKey(profile: string, id: string): string {
    return `${profile}\0${id}`
  }

  private cancelAuthorizationWatch(profile: string, id: string): void {
    const key = this.authorizationKey(profile, id)
    const watch = this.authorizationWatches.get(key)

    if (watch) {
      clearTimeout(watch.timer)
      this.authorizationWatches.delete(key)
    }
  }

  /** OAuth completes in the browser, so Electron—not the mounted page—owns the eventual Hermes config write. */
  private watchAuthorization(profile: string, id: keyof typeof CONNECTOR_SPECS): void {
    this.cancelAuthorizationWatch(profile, id)
    const key = this.authorizationKey(profile, id)
    const generation = ++this.authorizationGeneration
    const deadline = Date.now() + 15 * 60_000

    const poll = async () => {
      const current = this.authorizationWatches.get(key)

      if (this.closed || !current || current.generation !== generation) {
        return
      }

      try {
        // `execute` re-reads Hermes config inside the profile queue immediately before any write.
        const result = await this.request({ operation: 'enable', profile, id })

        if (result.connectors.some(row => row.id === id && row.connected)) {
          this.cancelAuthorizationWatch(profile, id)

          return
        }
      } catch (error) {
        // A name claimed while the browser was open belongs to the user; never retry into it.
        if (String(error).includes(`MCP name already exists: connector_${id}`)) {
          this.cancelAuthorizationWatch(profile, id)

          return
        }
      }

      if (Date.now() >= deadline) {
        this.cancelAuthorizationWatch(profile, id)

        return
      }

      const latest = this.authorizationWatches.get(key)

      if (latest?.generation === generation) {
        latest.timer = setTimeout(() => void poll(), 2000)
      }
    }

    this.authorizationWatches.set(key, { generation, timer: setTimeout(() => void poll(), 2000) })
  }

  request(input: LocalConnectorRequest): Promise<LocalConnectorResult> {
    // Validate again at the privileged boundary, independently of renderer types.
    if (
      !input ||
      typeof input.profile !== 'string' ||
      !['list', 'connect', 'authorize', 'disconnect', 'enable', 'qr.start', 'qr.poll', 'qr.cancel'].includes(
        input.operation
      )
    ) {
      return Promise.reject(new Error('Invalid connector request'))
    }

    const run = (this.queues.get(input.profile) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.execute(input))

    this.queues.set(input.profile, run)
    void run
      .finally(() => {
        if (this.queues.get(input.profile) === run) {
          this.queues.delete(input.profile)
        }
      })
      .catch(() => undefined)

    return run
  }

  agentMail(input: AgentMailRequest, phone: string): Promise<AgentMailResult> {
    if (
      !input ||
      typeof input.profile !== 'string' ||
      !['status', 'enable', 'disable', 'action'].includes(input.operation)
    ) {
      return Promise.reject(new Error('Invalid Agent Mail request'))
    }

    const run = (this.queues.get(input.profile) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.executeAgentMail(input, phone))

    this.queues.set(input.profile, run)
    void run
      .finally(() => {
        if (this.queues.get(input.profile) === run) {
          this.queues.delete(input.profile)
        }
      })
      .catch(() => undefined)

    return run
  }

  private async executeAgentMail(input: AgentMailRequest, phone: string): Promise<AgentMailResult> {
    const runtime = this.runtime(input.profile)
    const api = (method: string, route: string, body?: unknown) =>
      this.options.api({ connectionId: 'local', profile: input.profile, method, path: route, body })
    const saved = await api('GET', '/api/config?include_defaults=false')
    const entry = saved.mcp_servers?.connector_wo_mail
    const connection = await runtime.connection('wo_mail')
    const ownsEntry = entry?.desktop_agent_mail === true
    const status = (): AgentMailStatus => ({
      dailyQuota: 50,
      email: connection?.displayName ?? '',
      enabled: Boolean(connection && ownsEntry && entry.enabled !== false),
      todaySent: 0
    })

    if (input.operation === 'status') {
      return { status: status() }
    }

    if (input.operation === 'action') {
      if (!connection || !ownsEntry || entry.enabled === false) {
        throw new Error('请先开通智能体邮箱。')
      }
      if (!input.action || !AGENT_MAIL_ACTIONS.has(input.action)) {
        throw new Error('Unknown Agent Mail action')
      }
      if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input)) {
        throw new Error('Invalid Agent Mail action input')
      }

      const result = await runtime.request(`/v1/actions/wo_mail.${input.action}`, 'POST', {
        connectionName: 'default',
        input: input.input
      })

      if (!result || result.success !== true || !Object.hasOwn(result, 'data')) {
        throw new Error('沃邮箱返回了无效结果。')
      }

      return { data: result.data, status: status() }
    }

    if (entry && !ownsEntry) {
      throw new Error('MCP name already exists: connector_wo_mail')
    }

    if (input.operation === 'disable') {
      if (ownsEntry && entry.enabled !== false) {
        await api('PUT', '/api/config', { config: { mcp_servers: { connector_wo_mail: { enabled: false } } } })
      }

      return { status: { ...status(), enabled: false } }
    }

    let activeConnection = connection

    if (!activeConnection) {
      const authorizationCode = await fetchWoMailExclusiveCode(phone)
      const email = `${phone}@wo.cn`
      await runtime.request('/api/connections/wo_mail', 'PUT', {
        authType: 'custom_credential',
        connectionName: 'default',
        values: { authorizationCode, email }
      })
      activeConnection = await runtime.connection('wo_mail')
    }

    const next = { ...(await runtime.config('wo_mail')), desktop_agent_mail: true, enabled: true }
    await api('PUT', '/api/config', { config: { mcp_servers: { connector_wo_mail: next } } })

    return {
      status: {
        dailyQuota: 50,
        email: activeConnection?.displayName ?? `${phone}@wo.cn`,
        enabled: true,
        todaySent: 0
      }
    }
  }

  private async execute(input: LocalConnectorRequest): Promise<LocalConnectorResult> {
    const { profile, operation, id } = input
    const runtime = this.runtime(profile)

    const api = (method: string, route: string, body?: unknown) =>
      this.options.api({ connectionId: 'local', profile, method, path: route, body })

    if (operation !== 'list' && (!id || !Object.hasOwn(CONNECTOR_SPECS, id))) {
      throw new Error('Unknown connector')
    }

    if (operation.startsWith('qr.')) {
      if (id !== 'wecom_bot') {
        throw new Error('QR authorization is only available for WeCom')
      }

      if (operation === 'qr.start') {
        return { connectors: [], ...(await this.qr.start(profile)) }
      }

      if (operation === 'qr.cancel') {
        this.qr.cancelProfile(profile)

        return { connectors: [] }
      }

      if (typeof input.sessionId !== 'string' || input.sessionId.length > 64) {
        throw new Error('Invalid QR session')
      }

      const { result, values } = await this.qr.poll(profile, input.sessionId)

      if (values) {
        return { ...(await this.execute({ profile, id, operation: 'connect', values })), ...result }
      }

      return { connectors: [], ...result }
    }

    const saved = await api('GET', '/api/config?include_defaults=false')
    const existing = id ? saved.mcp_servers?.[`connector_${id}`] : undefined

    if (existing && existing.desktop_connector !== id && ['connect', 'authorize', 'enable'].includes(operation)) {
      throw new Error(`MCP name already exists: connector_${id}`)
    }

    if (operation === 'authorize') {
      if (CONNECTOR_SPECS[id!].auth !== 'oauth2') {
        throw new Error('This connector uses credentials')
      }

      const result = await runtime.request('/api/oauth/authorizations', 'POST', {
        service: id,
        connectionName: 'default'
      })

      const url = new URL(result.authorizationUrl)

      if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('Invalid OAuth authorization URL')
      }

      if (!this.options.active() || this.closed) {
        throw new Error('Connector account is no longer active')
      }

      await this.options.openExternal(url.href)
      this.watchAuthorization(profile, id!)

      return { connectors: await runtime.rows() }
    }

    if (operation === 'connect') {
      const spec = CONNECTOR_SPECS[id!]
      const values = input.values

      if (
        spec.auth === 'oauth2' ||
        !values ||
        typeof values !== 'object' ||
        Array.isArray(values) ||
        Object.keys(values).length !== spec.fields.length ||
        spec.fields.some(
          field => typeof values[field] !== 'string' || !values[field].trim() || values[field].length > 16_384
        )
      ) {
        throw new Error('Please complete the connector credentials')
      }

      await runtime.request(`/api/connections/${id}`, 'PUT', { authType: spec.auth, connectionName: 'default', values })
    }

    if (operation === 'disconnect') {
      this.cancelAuthorizationWatch(profile, id!)
      await runtime.request(`/api/connections/${id}`, 'DELETE')
    }

    const rows = await runtime.rows()
    const patch: Record<string, unknown> = {}

    for (const row of rows) {
      const name = `connector_${row.id}`
      const entry = saved.mcp_servers?.[name]

      if (entry && entry.desktop_connector !== row.id) {
        if (id === row.id && operation === 'connect') {
          throw new Error(`MCP name already exists: ${name}`)
        }

        continue
      }

      if (!entry && !row.connected) {
        continue
      }

      const next = {
        ...(row.connected ? await runtime.config(row.id) : {}),
        ...(!row.connected ? { enabled: false } : {})
      }

      if (row.id === id && row.connected && (operation === 'connect' || operation === 'enable')) {
        Object.assign(next, { enabled: true })
      }

      if (Object.entries(next).some(([key, value]) => JSON.stringify(entry?.[key]) !== JSON.stringify(value))) {
        patch[name] = next
      }
    }

    if (Object.keys(patch).length) {
      if (!this.options.active() || this.closed) {
        throw new Error('Connector account is no longer active')
      }

      await api('PUT', '/api/config', { config: { mcp_servers: patch } })
    }

    return { connectors: rows }
  }

  async close(): Promise<void> {
    this.closed = true
    this.qr.close()

    for (const watch of this.authorizationWatches.values()) {
      clearTimeout(watch.timer)
    }

    this.authorizationWatches.clear()

    await Promise.all([...this.runtimes.values()].map(runtime => runtime.close()))

    this.runtimes.clear()
  }
}
