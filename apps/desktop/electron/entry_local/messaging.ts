import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { writeSecretFileAtomic } from '../hardening'

import type { MessagingSetupRequest, MessagingSetupResult } from './messaging-contract'

const IDS = { dingtalk: 'DINGTALK_CLIENT_ID', feishu: 'FEISHU_APP_ID', wecom: 'WECOM_BOT_ID' }
const SECRETS = { dingtalk: 'DINGTALK_CLIENT_SECRET', feishu: 'FEISHU_APP_SECRET', wecom: 'WECOM_SECRET' }
const BASE = '/api/plugins/desktop-messaging'

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

  /** 请求始终由可信主进程定位到本机账号后端。 */
  constructor(
    private readonly deps: {
      account: string
      index: MessagingBotIndex
      request: (profile: string, path: string, method: string, body?: unknown) => Promise<any>
      sleep?: (milliseconds: number) => Promise<void>
    }
  ) {}

  /** 在 IPC 边界验证固定操作与字段，不接收 URL、路径或任意平台。 */
  run(input: MessagingSetupRequest): Promise<MessagingSetupResult> {
    if (
      !input ||
      !['save', 'disconnect', 'retry'].includes(input.operation) ||
      (input.operation !== 'retry' && !Object.hasOwn(IDS, input.platform ?? '')) ||
      (input.profile !== undefined && (typeof input.profile !== 'string' || !/^[\w-]{1,64}$/.test(input.profile))) ||
      (input.env !== undefined &&
        (!input.env ||
          typeof input.env !== 'object' ||
          Array.isArray(input.env) ||
          Object.entries(input.env).some(
            ([key, value]) =>
              typeof value !== 'string' ||
              value.length > 8192 ||
              ![IDS[input.platform!], SECRETS[input.platform!]].includes(key)
          )))
    ) {
      return Promise.reject(new Error('invalid_messaging_request'))
    }

    const result = this.pending.then(() => this.setup(input))
    this.pending = result.catch(() => undefined)

    return result
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
      return { actionFailed: !(await this.apply()) }
    }

    const platform = input.platform!
    const id = input.env?.[IDS[platform]]?.trim()

    if (
      input.operation === 'save' &&
      !input.confirmed &&
      this.deps.index.conflicts(this.deps.account, profile, platform, id)
    ) {
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
      return { saved: true, changed: result.changed, actionFailed: true }
    }

    return { saved: true, changed: result.changed, actionFailed: result.changed ? !(await this.apply()) : false }
  }

  /** 原版动作完成只表示启停结束；平台连接状态继续读取原版状态接口。 */
  private async apply(): Promise<boolean> {
    try {
      if (this.closed) {
        return false
      }

      const action = await this.deps.request('default', `${BASE}/apply`, 'POST', {})

      for (let attempt = 0; attempt < 150; attempt++) {
        await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1200)
        const status = await this.deps.request('default', `/api/actions/${action.name}/status?lines=1`, 'GET')

        if (!status.running) {
          return status.exit_code === 0
        }
      }

      return false
    } catch {
      return false
    }
  }
}
