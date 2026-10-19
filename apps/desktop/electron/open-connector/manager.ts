import path from 'node:path'

import { connectorHome, prepareConnectorConfig } from './config'
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
