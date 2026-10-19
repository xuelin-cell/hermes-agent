import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { writeSecretFileAtomic } from '../hardening'

import type { MessagingOperationStatus, MessagingSetupRequest, MessagingSetupResult } from './messaging-contract'

const IDS = { dingtalk: 'DINGTALK_CLIENT_ID', feishu: 'FEISHU_APP_ID', wecom: 'WECOM_BOT_ID' }
const SECRETS = { dingtalk: 'DINGTALK_CLIENT_SECRET', feishu: 'FEISHU_APP_SECRET', wecom: 'WECOM_SECRET' }
const BASE = '/api/plugins/desktop-messaging'

interface MessagingTask extends Omit<MessagingSetupRequest, 'operation'> {
  operation: NonNullable<MessagingOperationStatus['operation']>
}

/** 应用级摘要索引只保存机器人与账号摘要，不读取其他账号 Home。 */
export class MessagingBotIndex {
  private readonly file: string

  /** 固定应用数据根；调用方不能指定索引路径。 */
  constructor(userData: string) {
    this.file = path.join(userData, 'messaging-bots.json')
  }

  /** 损坏索引显式失败，避免把无法核实当作没有冲突。 */
  private read(): Record<string, Record<string, string>> {
    if (!fs.existsSync(this.file)) {
      return {}
    }

    const value = JSON.parse(fs.readFileSync(this.file, 'utf8'))

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('messaging_index_invalid')
    }

    for (const entries of Object.values(value)) {
      if (
        !entries ||
        typeof entries !== 'object' ||
        Array.isArray(entries) ||
        Object.values(entries).some(item => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item))
      ) {
        throw new Error('messaging_index_invalid')
      }
    }

    return value
  }

  /** 以完整账号和 Profile 区分归属；机器人 ID 本身不落盘。 */
  private owner(account: string, profile: string): string {
    return createHash('sha256')
      .update(JSON.stringify([account, profile]))
      .digest('hex')
  }

  /** 只返回是否被另一账号使用，不暴露账号、机器人或目录。 */
  conflicts(account: string, profile: string, platform: string, id?: string): boolean {
    const data = this.read()
    const owner = this.owner(account, profile)
    const digest = id ? createHash('sha256').update(id).digest('hex') : data[owner]?.[platform]

    return !!digest && Object.entries(data).some(([key, entry]) => key !== owner && entry[platform] === digest)
  }

  /** 只有服务器已保存配置后更新摘要；解绑只删除本归属记录。 */
  remember(account: string, profile: string, platform: string, id: string | null | undefined): void {
    if (id === undefined) {
      return
    }

    const data = this.read()
    const owner = this.owner(account, profile)
    data[owner] ??= {}

    if (id === null) {
      delete data[owner][platform]
    } else {
      data[owner][platform] = createHash('sha256').update(id).digest('hex')
    }

    writeSecretFileAtomic(this.file, JSON.stringify(data), { encoding: 'utf8' })
  }
}

/** 配置写入和网关动作共用账号串行队列，完成保存后独立报告连接动作失败。 */
export class DesktopMessaging {
  private pending: Promise<unknown> = Promise.resolve()
  private closed = false
  private state: MessagingOperationStatus = { phase: 'idle', revision: 0 }
  private submitted = new Set<string>()
  private restoration: Promise<MessagingSetupResult> | null = null

  /** 请求始终由可信主进程定位到本机账号后端。 */
  constructor(
    private readonly deps: {
      account: string
      index: MessagingBotIndex
      request: (profile: string, path: string, method: string, body?: unknown) => Promise<any>
      sleep?: (milliseconds: number) => Promise<void>
      onState?: (state: MessagingOperationStatus) => void
    }
  ) {}

  /** IPC 只等待接收和重复机器人确认；长任务由主进程继续执行。 */
  submit(input: MessagingSetupRequest): Promise<MessagingSetupResult> {
    this.validate(input)

    const key = createHash('sha256').update(JSON.stringify([
      input.operation, input.profile || 'default', input.platform, Object.entries(input.env || {}).sort(), !!input.confirmed
    ])).digest('hex')

    if (this.submitted.has(key)) {return Promise.resolve({ accepted: true })}

    if (input.operation === 'save' && !input.confirmed && this.deps.index.conflicts(
      this.deps.account, input.profile || 'default', input.platform!, input.env?.[IDS[input.platform as keyof typeof IDS]]?.trim()
    )) {
      return Promise.resolve({ confirmationRequired: true })
    }

    this.submitted.add(key)
    void this.run(input).finally(() => { this.submitted.delete(key) }).catch(() => undefined)

    return Promise.resolve({ accepted: true })
  }

  /** 只提供脱敏操作快照，页面切走或新窗口打开后仍可读取结果。 */
  status(): MessagingOperationStatus {
    return { ...this.state }
  }

  /** 主进程发布事实阶段；配置、凭据和原始异常不跨过状态 IPC。 */
  private publish(input: MessagingTask, phase: MessagingOperationStatus['phase'], saved = false, error?: string): void {
    this.state = { phase, revision: this.state.revision + 1, profile: input.profile || 'default',
      platform: input.platform, operation: input.operation, saved, ...(error ? { error } : {}) }
    this.deps.onState?.(this.status())
  }

  /** 在 IPC 边界验证固定操作与字段，不接收 URL、路径或任意平台。 */
  private validate(input: MessagingSetupRequest): void {
    if (
      !input || typeof input !== 'object' ||
      !['save', 'disconnect', 'retry', 'watch'].includes(input.operation) ||
      (input.platform !== undefined && !['weixin', ...Object.keys(IDS)].includes(input.platform)) ||
      (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') ||
      (input.operation === 'save' && !Object.hasOwn(IDS, input.platform ?? '')) ||
      (input.operation === 'disconnect' && !['weixin', ...Object.keys(IDS)].includes(input.platform ?? '')) ||
      (input.profile !== undefined && (typeof input.profile !== 'string' || !/^[\w-]{1,64}$/.test(input.profile))) ||
      (input.env !== undefined &&
        (!input.env ||
          typeof input.env !== 'object' ||
          Array.isArray(input.env) ||
          Object.entries(input.env).some(
            ([key, value]) =>
              typeof value !== 'string' ||
              value.length > 8192 ||
              ![IDS[input.platform as keyof typeof IDS], SECRETS[input.platform as keyof typeof IDS]].includes(key) ||
              input.operation !== 'save'
          )))
    ) {
      throw new Error('invalid_messaging_request')
    }

    if (this.closed) {throw new Error('messaging_account_closed')}
  }

  /** 可等待的执行入口用于串行队列与检查；Renderer 使用立即返回的 submit。 */
  run(input: MessagingSetupRequest): Promise<MessagingSetupResult> {
    try {
      this.validate(input)
    } catch (cause) {
      return Promise.reject(cause)
    }

    return this.enqueue(input, () => this.setup(input))
  }

  /** 每次账号进程只自动恢复一次；不依赖页面，失败不循环重启。 */
  restore(): Promise<MessagingSetupResult> {
    const input: MessagingTask = { operation: 'restore', profile: 'default' }
    this.restoration ??= this.enqueue(input, () => this.restoreGateway(input))

    return this.restoration
  }

  /** 启动、保存和解绑共用同一队列；封闭后不再执行任何新操作。 */
  private enqueue(input: MessagingTask, action: () => Promise<MessagingSetupResult>): Promise<MessagingSetupResult> {
    const result = this.pending.then(async () => {
      try {
        if (this.closed) {throw new Error('messaging_account_closed')}

        return await action()
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : ''

        const codes = ['credentials_rejected', 'credentials_required', 'secret_required_for_new_id',
          'validation_network', 'validation_timeout', 'validation_response', 'validation_unavailable', 'gateway_identity_unverified']

        this.publish(input, 'failed', input.operation === 'restore', codes.find(code => message.includes(code)) || 'save_failed')
        throw cause
      }
    })

    this.pending = result.catch(() => undefined)

    return result
  }

  /** 原版插件负责准备和可信复用；有动作才等待动作，随后核对全部受管配置。 */
  private async restoreGateway(input: MessagingTask, restart = false): Promise<MessagingSetupResult> {
    this.publish(input, 'applying', true)
    let state = await this.deps.request('default', `${BASE}/restore${restart ? '?restart=true' : ''}`, 'POST', {})

    if (state.name === 'gateway-stop') {
      this.publish(input, 'stopping', true)

      if (!(await this.watch('default', 'gateway-stop')) || this.closed) {
        this.publish(input, 'failed', true, 'apply_failed')

        return { actionFailed: true }
      }

      state = await this.deps.request('default', `${BASE}/restore`, 'POST', {})
    }

    if (state.configured === false) {
      this.publish(input, 'idle')

      return {}
    }

    if (!Array.isArray(state.profiles) || !state.profiles.length ||
      state.profiles.some(name => typeof name !== 'string' || !/^[\w-]{1,64}$/.test(name))) {
      throw new Error('restore_response_invalid')
    }

    if (state.name && state.name !== 'gateway-start') {throw new Error('restore_response_invalid')}

    // gateway-start 是原版常驻 run 进程，不能等待它退出才判断启动完成。
    const ok = await this.checkPlatforms(input, false, state.profiles)
    this.publish(input, ok ? 'completed' : 'failed', true, ok ? undefined : 'apply_failed')

    return { actionFailed: !ok }
  }

  /** 停止接受新操作；退出快照前等待已有动作结束。 */
  seal(): void {
    this.closed = true
  }

  /** 等待已发起的动作，防止退出完成后旧启动器再次拉起网关。 */
  async settle(): Promise<void> {
    await this.pending
  }

  /** 先检查机器人冲突，再验证保存；保存成功不因动作失败被误报为保存失败。 */
  private async setup(input: MessagingSetupRequest): Promise<MessagingSetupResult> {
    if (this.closed) {
      throw new Error('messaging_account_closed')
    }

    const profile = input.profile || 'default'

    if (input.operation === 'retry') {
      if (this.state.phase === 'failed' && this.state.operation === 'restore') {
        return this.restoreGateway({ ...input, operation: 'restore' }, true)
      }

      return { actionFailed: !(await this.apply(input)) }
    }

    if (input.operation === 'watch') {
      this.publish(input, 'restarting', true)
      const ok = await this.watch(profile, 'gateway-restart') && await this.checkPlatforms(input)
      this.publish(input, ok ? 'completed' : 'failed', true, ok ? undefined : 'apply_failed')

      return { actionFailed: !ok }
    }

    this.publish(input, 'saving')

    if (input.platform === 'weixin') {
      await this.deps.request(profile, `/api/plugins/weixin-qr/unbind?profile=${encodeURIComponent(profile)}`, 'POST', {})

      return { saved: true, changed: true, actionFailed: !(await this.apply(input)) }
    }

    const platform = input.platform!
    const id = input.env?.[IDS[platform]]?.trim()

    if (
      input.operation === 'save' &&
      !input.confirmed &&
      this.deps.index.conflicts(this.deps.account, profile, platform, id)
    ) {
      this.publish(input, 'failed', false, 'bot_conflict')

      return { confirmationRequired: true }
    }

    const query = `?profile=${encodeURIComponent(profile)}`

    const result = await this.deps.request(profile, `${BASE}/platforms/${platform}${query}`, 'PUT', {
      enabled: input.operation === 'save',
      env: input.operation === 'save' ? input.env || {} : {}
    })

    try {
      this.deps.index.remember(this.deps.account, profile, platform, input.operation === 'disconnect' ? null : id)
    } catch {
      this.publish(input, 'failed', true, 'apply_failed')

      return { saved: true, changed: result.changed, actionFailed: true }
    }

    if (!result.changed) {this.publish(input, 'completed', true)}

    return { saved: true, changed: result.changed, actionFailed: result.changed ? !(await this.apply(input)) : false }
  }

  /** 原版动作完成后继续确认平台状态，不把启动辅助命令退出当成连接成功。 */
  private async apply(input: MessagingSetupRequest): Promise<boolean> {
    this.publish(input, 'applying', true)
    let ok = false

    try {
      if (this.closed) {
        return false
      }

      const action = await this.deps.request('default', `${BASE}/apply`, 'POST', {})
      this.publish(input, action.name === 'gateway-stop' ? 'stopping' : 'restarting', true)
      ok = await this.watch('default', action.name) && await this.checkPlatforms(input, action.name === 'gateway-stop')

      return ok
    } catch {
      return false
    } finally {
      this.publish(input, ok ? 'completed' : 'failed', true, ok ? undefined : 'apply_failed')
    }
  }

  /** 在原 Profile 有界确认可见平台已连接或网关已停止；只读状态，不再次启停。 */
  private async checkPlatforms(input: MessagingTask, stopped = false, profiles = [input.profile || 'default']): Promise<boolean> {
    this.publish(input, 'checking', true)
    const deadline = Date.now() + 36_000

    for (let attempt = 0; attempt < 30 && Date.now() < deadline && !this.closed; attempt++) {
      try {
        const results = await Promise.allSettled(profiles.map(profile =>
          this.deps.request(profile, `/api/messaging/platforms?profile=${encodeURIComponent(profile)}`, 'GET')))

        if (results.every(result => {
          if (result.status !== 'fulfilled') {return false}

          const rows = Array.isArray(result.value?.platforms) ? result.value.platforms : []
          const target = rows.find(row => row?.id === input.platform)

          const targetReady = !input.platform || (target && (input.operation === 'disconnect'
            ? !target.enabled : target.enabled && target.configured))

          return rows.length && targetReady && (stopped
            ? rows.every(row => row && row.gateway_running === false)
            : rows.some(row => row?.gateway_running === true) && rows
              .filter(row => row && ['weixin', ...Object.keys(IDS)].includes(row.id) && row.enabled && row.configured)
              .every(row => row.gateway_running === true && row.state === 'connected'))
        })) {
          return true
        }
      } catch {
        // 读取失败不当作就绪；仍受总期限和次数上限约束。
      }

      if (attempt < 29 && !this.closed && Date.now() < deadline) {
        await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1200)
      }
    }

    return false
  }

  /** 有界跟踪既有动作；轮询不依赖页面存在，也不会触发第二次重启。 */
  private async watch(profile: string, name: string): Promise<boolean> {
    try {
      for (let attempt = 0; attempt < 150; attempt++) {
        await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1200)
        const status = await this.deps.request(profile, `/api/actions/${name}/status?lines=1`, 'GET')

        if (!status.running) {return status.exit_code === 0}
      }
    } catch {
      return false
    }

    return false
  }
}
