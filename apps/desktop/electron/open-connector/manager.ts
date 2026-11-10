import path from 'node:path'

import type { AgentMailAction, AgentMailRequest, AgentMailResult, AgentMailStatus } from '../agent-mail/contract'
import { fetchWoMailExclusiveCode } from '../agent-mail/exclusive-code'
import type { AgentMailLocalStateStore } from '../agent-mail/local-state'
import { readAgentMailQuotaStatus } from '../agent-mail/quota-status'
import type { LoginIdentity } from '../login/session'

import { connectorHome, prepareAgentMailConfig, prepareConnectorConfig } from './config'
import { CONNECTOR_SPECS, type LocalConnectorRequest, type LocalConnectorResult } from './contract'
import { ConnectorRuntime, type ConnectorRuntimeOptions } from './runtime'
import { WecomQrSessions } from './wecom-qr'

interface ConnectorManagerOptions extends Omit<ConnectorRuntimeOptions, 'directory'> {
  home: string
  profiles: () => string[]
  active: () => boolean
  api: (request: {
    connectionId: string
    profile: string
    path: string
    method?: string
    body?: unknown
    priority?: 'foreground' | 'background'
  }) => Promise<any>
  openExternal: (url: string) => Promise<void>
  log: (message: string) => void
  identity: () => LoginIdentity | null
  mailState: Pick<AgentMailLocalStateStore, 'get' | 'save'>
  saveAttachment: (name: string, download: () => Promise<Response>) => Promise<{ canceled: boolean; saved: boolean }>
  stageAttachment: (name: string, download: () => Promise<Response>) => Promise<{ name: string; path: string }>
  exclusiveCode?: (phone: string) => Promise<string>
}

const AGENT_MAIL_ACTIONS: ReadonlySet<AgentMailAction> = new Set([
  'delete_email',
  'download_attachment',
  'get_email',
  'get_folder_status',
  'list_folders',
  'mark_email_read',
  'search_emails',
  'stage_attachment'
])

// 后端被收掉、正在重启或排队等名额时 main 给的几种英文报错。
const BACKEND_UNAVAILABLE = /was retired|failed to start|free local slot|waiting for a free slot|was cancelled while queued/i

/** 写配置时档案后端不在：换成用户看得懂的中文，不把进程池的英文原样显示在连接器卡片上。其他错误返回 null。 */
export function backendUnavailable(error: unknown, profile: string): Error | null {
  const message = error instanceof Error ? error.message : String(error ?? '')

  if (!BACKEND_UNAVAILABLE.test(message)) {
    return null
  }

  const who = profile === 'default' ? '通用助手' : '这个助手'

  return new Error(`${who}的后台正在重新打开，请稍后再点一次。`)
}

/** 同一账号共用连接器授权，各助手仍由 Hermes 保存自己的 MCP 配置。 */
export class ConnectorManager {
  private sharedRuntime: ConnectorRuntime | null = null
  private mailStartup: { start: Promise<void>; result: Promise<void> } | null = null
  private queues = new Map<string, Promise<unknown>>()
  private authorizationWatches = new Map<string, { generation: number; timer: NodeJS.Timeout }>()
  private authorizationGeneration = 0
  private closed = false
  private qr = new WecomQrSessions()

  constructor(private readonly options: ConnectorManagerOptions) {}

  private logAgentMail(message: string): void {
    this.options.log(`[agent-mail] ${message}`)
  }

  private isCurrentIdentity(expected: LoginIdentity): boolean {
    const current = this.options.identity()

    return Boolean(
      !this.closed && this.options.active() && current &&
        current.uid === expected.uid &&
        current.token === expected.token &&
        current.phone === expected.phone
    )
  }

  /** 连接器固定落在账号主助手目录，专家不再创建或读取自己的授权库。 */
  private runtime(): ConnectorRuntime {
    if (this.closed || !this.options.active()) {
      throw new Error('Connector account is no longer active')
    }

    const home = connectorHome(this.options.home, 'default')
    this.sharedRuntime ??= new ConnectorRuntime({ ...this.options, directory: path.join(home, 'open-connector') })

    return this.sharedRuntime
  }

  /** 只预热连接器，不写任何正在运行的助手配置。 */
  async start(): Promise<void> {
    await this.runtime().start()
  }

  /** 专家后端尚未启动时，刷新它的受管条目并指向账号共享连接器。 */
  async prepare(profile: string): Promise<void> {
    const home = connectorHome(this.options.home, profile)
    const runtime = this.runtime()
    const rows = await runtime.rows()
    await prepareConnectorConfig(
      home,
      rows.filter(row => row.connected).map(row => row.id),
      id => runtime.config(id)
    )
    const mail = await this.agentMailConfig(runtime)

    if (mail) {
      await prepareAgentMailConfig(home, true, async () => mail, mail.enabled)
    }
  }

  /** 后端就绪后走正式配置接口，连接器和邮箱均不直接回写运行中的 YAML。 */
  async refresh(profile: string): Promise<void> {
    await this.request({ operation: 'list', profile })
    await this.enqueue(profile, async () => {
      const mail = await this.agentMailConfig(this.runtime())

      if (!mail || this.closed || !this.options.active()) {return}

      // 固定走当前助手的后台配置接口，不接受页面提供的服务地址。
      const api = (method: string, route: string, body?: unknown) =>
        this.options.api({ connectionId: 'local', profile, method, path: route, body, priority: 'background' })

      const saved = await api('GET', '/api/config?include_defaults=false')
      const entry = saved.mcp_servers?.connector_wo_mail

      if (entry && entry.desktop_agent_mail !== true) {return}

      if (Object.entries(mail).some(([key, value]) => JSON.stringify(entry?.[key]) !== JSON.stringify(value))) {
        if (this.closed || !this.options.active()) {return}

        await api('PUT', '/api/config', { config: { mcp_servers: { connector_wo_mail: mail } } })
      }
    })
  }

  /** 按助手串行刷新共享授权，不因一个档案失败中断其余助手，也不启动额外进程。 */
  async refreshAll(skip?: string): Promise<void> {
    for (const profile of this.options.profiles()) {
      if (this.closed || !this.options.active()) {
        return
      }

      if (profile === skip) {
        continue
      }

      try {
        await this.refresh(profile)
      } catch {
        this.options.log(`[connectors] config refresh failed profile=${profile}`)
      }
    }
  }

  /** 页面操作后先刷新当前助手再返回，其余助手放到后台刷新，不让用户等全部助手。 */
  private async refreshAfterChange(profile: string): Promise<void> {
    try {
      await this.refresh(profile)
    } catch {
      this.options.log(`[connectors] config refresh failed profile=${profile}`)
    }

    void this.refreshAll(profile).catch(() => this.options.log('[connectors] background config refresh failed'))
  }

  /** 同一运行期只自动恢复一次邮箱；失败也记住，避免每开一个专家就重复申请专属码。 */
  private async agentMailConfig(runtime: ConnectorRuntime): Promise<(Record<string, unknown> & { enabled: boolean }) | null> {
    const start = runtime.start()

    if (this.mailStartup?.start !== start) {
      this.mailStartup = {
        start,
        result: start.then(() => this.initializeAgentMail(runtime).catch(() => {
          this.logAgentMail('startup sync failed; no further automatic attempt for this runtime')
        }))
      }
    }

    await this.mailStartup.result
    const identity = this.options.identity()

    if (this.closed || !this.options.active() || !identity || !/^1\d{10}$/.test(identity.phone?.trim() ?? '')) {return null}

    const connection = await runtime.connection('wo_mail')

    const enabled = connection?.displayName.trim().toLowerCase() === `${identity.phone.trim()}@wo.cn` &&
      this.options.mailState.get(identity)?.enabled !== false

    return { ...(await runtime.config('wo_mail')), desktop_agent_mail: true, enabled }
  }

  /** 只维护共享授权库和账号邮箱偏好；各助手随后分别保存自己的 MCP 条目。 */
  private async initializeAgentMail(runtime: ConnectorRuntime): Promise<void> {
    const identity = this.options.identity()
    const phone = identity?.phone?.trim() ?? ''

    if (!identity || !/^1\d{10}$/.test(phone)) {
      this.logAgentMail('startup sync skipped because no valid phone identity is available')

      return
    }

    this.logAgentMail('startup sync started for the shared account runtime')
    let connection = await runtime.connection('wo_mail')
    const expectedEmail = `${phone}@wo.cn`

    if (connection && connection.displayName.trim().toLowerCase() !== expectedEmail.toLowerCase()) {
      this.logAgentMail('startup sync removed a connection owned by a different phone')
      await runtime.request('/api/connections/wo_mail', 'DELETE')
      connection = null
    }

    const saved = this.options.mailState.get(identity)
    this.logAgentMail(`local state ${saved ? `found enabled=${saved.enabled} authorization-code=${Boolean(saved.authorizationCode)}` : 'not found'}`)

    if (saved && !saved.enabled) {
      this.logAgentMail('startup sync kept the mailbox disabled by local preference')

      return
    }

    if (!connection) {
      const created = await this.createAgentMailConnection(runtime, identity, phone, expectedEmail, saved?.authorizationCode)

      if (!this.isCurrentIdentity(identity)) {throw new Error('登录账号已经变更，请重试。')}

      this.options.mailState.save(identity, { authorizationCode: created.authorizationCode, email: expectedEmail, enabled: true })
      this.logAgentMail('local Wo Mail connection saved and authorization code persisted')
    }

    this.logAgentMail('startup sync completed')
  }

  private fetchAgentMailCode(phone: string): Promise<string> {
    if (this.options.exclusiveCode) {
      this.logAgentMail('requesting a new exclusive code through the configured test/provider callback')

      return this.options.exclusiveCode(phone)
    }

    return fetchWoMailExclusiveCode(phone, fetch, message => this.options.log(message))
  }

  /**
   * The Wo Mail exclusive code is short-lived. It is cached only to restore a
   * local mailbox after restart, so a failed cached-code connection gets one
   * fresh code and one retry. A newly fetched code is never retried here.
   */
  private async createAgentMailConnection(
    runtime: ConnectorRuntime,
    identity: LoginIdentity,
    phone: string,
    email: string,
    cachedAuthorizationCode?: string
  ): Promise<{ authorizationCode: string; connection: NonNullable<Awaited<ReturnType<ConnectorRuntime['connection']>>> }> {
    const connect = async (authorizationCode: string) => {
      await runtime.request('/api/connections/wo_mail', 'PUT', {
        authType: 'custom_credential',
        connectionName: 'default',
        values: { authorizationCode, email }
      })
      const connection = await runtime.connection('wo_mail')

      if (!connection) {
        throw new Error('沃邮箱连接没有保存成功。')
      }

      return connection
    }

    const authorizationCode = cachedAuthorizationCode || await this.fetchAgentMailCode(phone)
    this.logAgentMail(`creating local Wo Mail connection authorization-source=${cachedAuthorizationCode ? 'local-state' : 'Wo-Mail'}`)

    if (!this.isCurrentIdentity(identity)) {
      throw new Error('登录账号已经变更，请重试。')
    }

    try {
      return { authorizationCode, connection: await connect(authorizationCode) }
    } catch (error) {
      if (!cachedAuthorizationCode) {
        throw error
      }

      this.logAgentMail('cached exclusive code was rejected; requesting a fresh code and retrying once')
      this.options.mailState.save(identity, { email, enabled: true })
      const refreshedAuthorizationCode = await this.fetchAgentMailCode(phone)

      if (!this.isCurrentIdentity(identity)) {
        throw new Error('登录账号已经变更，请重试。')
      }

      return { authorizationCode: refreshedAuthorizationCode, connection: await connect(refreshedAuthorizationCode) }
    }
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

    return this.enqueue(input.profile, () => this.execute(input)).then(async result => {
      if (
        input.operation === 'disconnect' ||
        (['connect', 'enable', 'qr.poll'].includes(input.operation) &&
          result.connectors.some(row => row.id === input.id && row.connected))
      ) {
        await this.refreshAfterChange(input.profile)
      }

      return result
    })
  }

  agentMail(input: AgentMailRequest): Promise<AgentMailResult> {
    if (
      !input ||
      typeof input.profile !== 'string' ||
      !['status', 'enable', 'disable', 'action'].includes(input.operation)
    ) {
      return Promise.reject(new Error('Invalid Agent Mail request'))
    }

    return this.enqueue(input.profile, () => this.executeAgentMail(input)).then(async result => {
      if (input.operation === 'enable' || input.operation === 'disable') {
        await this.refreshAfterChange(input.profile)
      }

      return result
    })
  }

  /** 同一助手的页面操作与后台刷新串行，避免用旧快照盖过刚保存的配置。 */
  private enqueue<T>(profile: string, action: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(profile) ?? Promise.resolve())
      .catch(() => undefined)
      .then(action)

    this.queues.set(profile, run)
    void run
      .finally(() => {
        if (this.queues.get(profile) === run) {
          this.queues.delete(profile)
        }
      })
      .catch(() => undefined)

    return run
  }

  private async executeAgentMail(input: AgentMailRequest): Promise<AgentMailResult> {
    connectorHome(this.options.home, input.profile)
    const runtime = this.runtime()
    const identity = this.options.identity()
    const phone = identity?.phone?.trim() ?? ''
    this.logAgentMail(`IPC operation started operation=${input.operation}${input.action ? ` action=${input.action}` : ''}`)

    const api = (method: string, route: string, body?: unknown) =>
      this.options.api({ connectionId: 'local', profile: input.profile, method, path: route, body })

    const saved = await api('GET', '/api/config?include_defaults=false')
    const entry = saved.mcp_servers?.connector_wo_mail
    let connection = await runtime.connection('wo_mail')
    const expectedEmail = /^1\d{10}$/.test(phone) ? `${phone}@wo.cn` : ''

    if (!expectedEmail || (connection && connection.displayName.trim().toLowerCase() !== expectedEmail.toLowerCase())) {
      connection = null
    }

    const ownsEntry = entry?.desktop_agent_mail === true

    const status = (): AgentMailStatus => ({
      ...readAgentMailQuotaStatus(
        path.join(connectorHome(this.options.home, 'default'), 'open-connector'),
        connection?.displayName ?? expectedEmail
      ),
      email: connection?.displayName ?? '',
      enabled: Boolean(connection && ownsEntry && entry.enabled !== false)
    })

    if (input.operation === 'status') {
      this.logAgentMail(`IPC status completed enabled=${status().enabled}`)

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

      const connectorAction = input.action === 'stage_attachment' ? 'download_attachment' : input.action

      const result = await runtime.request(`/v1/actions/wo_mail.${connectorAction}`, 'POST', {
        connectionName: 'default',
        input: input.input
      })

      if (!result || result.success !== true || !Object.hasOwn(result, 'data')) {
        throw new Error('沃邮箱返回了无效结果。')
      }

      if (input.action === 'download_attachment') {
        const file = result.data?.file

        if (!file || typeof file.name !== 'string' || typeof file.downloadUrl !== 'string') {
          throw new Error('Mail attachment download response was invalid')
        }

        const saved = await this.options.saveAttachment(file.name, () => runtime.download(file.downloadUrl))
        this.logAgentMail(`IPC mailbox attachment save completed saved=${saved.saved} cancelled=${saved.canceled}`)

        return { data: saved, status: status() }
      }

      if (input.action === 'stage_attachment') {
        const file = result.data?.file

        if (!file || typeof file.name !== 'string' || typeof file.downloadUrl !== 'string') {
          throw new Error('Mail attachment download response was invalid')
        }

        const staged = await this.options.stageAttachment(file.name, () => runtime.download(file.downloadUrl))
        this.logAgentMail(`IPC mailbox attachment staged name=${staged.name}`)

        return { data: { file: staged }, status: status() }
      }

      this.logAgentMail(`IPC mailbox action completed action=${input.action}`)

      return { data: result.data, status: status() }
    }

    if (entry && !ownsEntry) {
      throw new Error('MCP name already exists: connector_wo_mail')
    }

    if (input.operation === 'disable') {
      if (ownsEntry && entry.enabled !== false) {
        await api('PUT', '/api/config', { config: { mcp_servers: { connector_wo_mail: { enabled: false } } } })
      }

      if (identity && /^1\d{10}$/.test(phone)) {
        const saved = this.options.mailState.get(identity)
        this.options.mailState.save(identity, {
          ...(saved?.authorizationCode ? { authorizationCode: saved.authorizationCode } : {}),
          email: connection?.displayName ?? saved?.email ?? expectedEmail,
          enabled: false
        })
        this.logAgentMail('IPC disable persisted the local disabled preference')
      }

      return { status: { ...status(), enabled: false } }
    }

    let activeConnection = connection

    if (!activeConnection) {
      if (!identity || !/^1\d{10}$/.test(phone)) {
        throw new Error('请先登录有效的手机号账号。')
      }

      const saved = this.options.mailState.get(identity)
      const email = `${phone}@wo.cn`
      const created = await this.createAgentMailConnection(runtime, identity, phone, email, saved?.authorizationCode)
      activeConnection = created.connection
      this.options.mailState.save(identity, { authorizationCode: created.authorizationCode, email, enabled: true })
      this.logAgentMail('IPC enable persisted the local authorization code')
    }

    const next = { ...(await runtime.config('wo_mail')), desktop_agent_mail: true, enabled: true }
    await api('PUT', '/api/config', { config: { mcp_servers: { connector_wo_mail: next } } })

    if (identity && /^1\d{10}$/.test(phone)) {
      const saved = this.options.mailState.get(identity)
      this.options.mailState.save(identity, {
        ...(saved?.authorizationCode ? { authorizationCode: saved.authorizationCode } : {}),
        email: activeConnection?.displayName ?? expectedEmail,
        enabled: true
      })
      this.logAgentMail('IPC enable persisted the local enabled preference')
    }

    return {
      status: {
        ...readAgentMailQuotaStatus(
          path.join(connectorHome(this.options.home, 'default'), 'open-connector'),
          activeConnection?.displayName ?? expectedEmail
        ),
        email: activeConnection?.displayName ?? `${phone}@wo.cn`,
        enabled: true
      }
    }
  }

  private async execute(input: LocalConnectorRequest): Promise<LocalConnectorResult> {
    const { profile, operation, id } = input
    connectorHome(this.options.home, profile)
    const runtime = this.runtime()

    // 「连接」「授权」「启用」「断开」是用户点的，要马上写配置：按前台去开这个档案的后端，刚被收掉也会重新拉起来。
    // 连接器页每隔一会儿的 list 只是看状态，按后台走，不跟用户正在打开的专家抢名额。
    const priority = operation === 'list' ? 'background' : 'foreground'

    const api = async (method: string, route: string, body?: unknown) => {
      try {
        return await this.options.api({ connectionId: 'local', profile, method, path: route, body, priority })
      } catch (error) {
        throw backendUnavailable(error, profile) ?? error
      }
    }

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
      const authorization = CONNECTOR_SPECS[id!].auth

      if (authorization !== 'oauth2' && authorization !== 'browser_poll') {
        throw new Error('This connector uses credentials')
      }

      const result = await runtime.request(
        authorization === 'oauth2' ? '/api/oauth/authorizations' : `/api/browser-authorizations/${id}`,
        'POST',
        {
        service: id,
        connectionName: 'default'
        }
      )

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
        spec.auth === 'browser_poll' ||
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
        ...(row.connected ? { enabled: true } : { enabled: false })
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

    await this.sharedRuntime?.close()
  }
}
