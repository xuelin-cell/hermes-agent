import { createHash } from 'node:crypto'

import type { LoginIdentity } from './session'

export interface DriveTokenRecord {
  token: string
  expiresAt: number
}

export interface DriveTokenStorage {
  load(owner: string): DriveTokenRecord | null
  save(owner: string, record: DriveTokenRecord): void
  clear(): void
}

export interface DriveCredentialOptions {
  store?: DriveTokenStorage
  now?: () => number
}

interface CredentialContext {
  owner: string
  identity: LoginIdentity
  record: DriveTokenRecord | null
  pending: Promise<string> | null
  lastRecoveryAt?: number
}

/** 云盘令牌独立于桌面登录，按账号和登录身份隔离，只在主进程读取或续期。 */
export class CloudDriveCredentials {
  private context: CredentialContext | null = null
  private readonly now: () => number

  /** 网络和密文存储由主进程注入，测试使用临时目录和可控时间。 */
  constructor(
    private readonly identity: () => LoginIdentity | null,
    private readonly acquire: (identity: LoginIdentity) => Promise<string>,
    private readonly options: DriveCredentialOptions = {}
  ) {
    this.now = options.now ?? Date.now
  }

  /** 登录变更即换归属，旧请求无法向新账号发布令牌或写入缓存。 */
  private current(): CredentialContext {
    const identity = this.identity()

    if (!identity || identity.expiresAt <= this.now()) {
      throw new Error('登录状态已变化，请重新登录')
    }

    const owner = createHash('sha256')
      .update(JSON.stringify([identity.uid, identity.token, identity.phone]))
      .digest('hex')

    if (this.context?.owner !== owner) {
      this.context = { owner, identity, record: this.options.store?.load(owner) ?? null, pending: null }
    }

    return this.context
  }

  /** 等待网络后再次校验上下文，不因切回同一账号而认领旧请求。 */
  private check(context: CredentialContext): void {
    if (this.current() !== context) {
      throw new Error('登录状态已变化，请重新打开资料库')
    }
  }

  /** 同一归属合并续期，七天有效期与原数字员工一致，成功后先安全保存再发布。 */
  private async renew(context: CredentialContext): Promise<string> {
    this.check(context)

    if (context.pending) {
      return context.pending
    }

    const requestedAt = this.now()

    const pending = (async () => {
      const token = await this.acquire(context.identity)
      this.check(context)
      const record = { token, expiresAt: requestedAt + 7 * 24 * 60 * 60 * 1000 }
      this.options.store?.save(context.owner, record)
      context.record = record

      return token
    })()

    context.pending = pending

    try {
      return await pending
    } finally {
      if (context.pending === pending) {
        context.pending = null
      }
    }
  }

  /** 每次使用前检查到期；有效密文可跨重启复用，过期只合并一次获取。 */
  async get(): Promise<string> {
    const context = this.current()

    if (context.pending) {
      return context.pending
    }

    if (!context.record && context.lastRecoveryAt !== undefined && this.now() - context.lastRecoveryAt < 60_000) {
      throw new Error('个人云盘令牌暂时无法恢复，请稍后重试')
    }

    return context.record && context.record.expiresAt > this.now() ? context.record.token : this.renew(context)
  }

  /** 明确过期才恢复；迟到的旧拒绝复用新令牌，失败后的强制续期一分钟内不再发起。 */
  async recover(rejectedToken: string): Promise<string> {
    const context = this.current()

    if (context.pending) {
      return context.pending
    }

    if (context.record && context.record.token !== rejectedToken && context.record.expiresAt > this.now()) {
      return context.record.token
    }

    if (context.lastRecoveryAt !== undefined && this.now() - context.lastRecoveryAt < 60_000) {
      throw new Error('个人云盘令牌暂时无法恢复，请稍后重试')
    }

    context.lastRecoveryAt = this.now()
    context.record = null

    return this.renew(context)
  }

  /** 定时与唤醒只检查已经启用的云盘，不为从未打开过云盘的账号获取令牌。 */
  async renewActive(): Promise<void> {
    const identity = this.identity()

    if (
      this.context &&
      identity &&
      identity.uid === this.context.identity.uid &&
      identity.token === this.context.identity.token &&
      identity.phone === this.context.identity.phone
    ) {
      await this.get()
    }
  }

  /** 退出成功后失效所有在途获取，再移除本账号的云盘密文。 */
  clear(): void {
    this.context = null
    this.options.store?.clear()
  }
}
