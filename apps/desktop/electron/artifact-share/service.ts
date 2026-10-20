import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { artifactShareActive, artifactShareDeadline, artifactShareExpired, type ArtifactShareRecord, type ArtifactSharePublishInput, type ArtifactShareSource } from '../../../shared/src/artifact-share'
import { deleteSharedPage, uploadShareHtml } from '../share-gateway'

import { ArtifactOriginStore, type OriginEvent } from './origins'

const MAX_BYTES = 2 * 1024 * 1024
const SHARE_ID = /^[A-Za-z0-9_-]{16,64}$/

interface PendingShare {
  key: string
  shareId: string
  expiresAt?: string | null
}

export interface ShareIdentity {
  accountId: string
  home: string
  token: string
}

export interface ShareServiceDeps {
  identity: () => ShareIdentity | null
  request?: typeof fetch
  changed?: (key: string) => void
  now?: () => number
}

/** 为当前登录账号管理公开快照；工具和预览按钮共用同一实例。 */
export class ArtifactShareService {
  private readonly pending = new Map<string, Promise<unknown>>()

  /** 注入身份读取和网络请求，以便在真实文件系统上验证生命周期。 */
  constructor(private readonly deps: ShareServiceDeps) {}

  /** 插件只能通过受鉴权桥登记事实；来源变化通知所有打开的分享入口。 */
  recordOrigin(event: OriginEvent): void {
    new ArtifactOriginStore(this.identity().home).record(event)
    this.deps.changed?.('*')
  }

  /** 上传入口只能把会话标记为不可分享，不能提升任何文件的来源等级。 */
  markUploaded(sessionId: string): void {
    new ArtifactOriginStore(this.identity().home).markUploaded(sessionId)
    this.deps.changed?.('*')
  }

  /** 返回当前来源资格，与真实发布使用同一份持久记录。 */
  eligibility(source: ArtifactShareSource) {
    return new ArtifactOriginStore(this.identity().home).eligibility(source)
  }

  /** 获取当前有效账号，拒绝使用页面提供的身份或过期登录。 */
  private identity(): ShareIdentity {
    const identity = this.deps.identity()

    if (!identity?.accountId || !identity.token || !path.isAbsolute(identity.home)) {
      throw new Error('请先登录有效的账号，再分享产物。')
    }

    return identity
  }

  /** 将记录限制在当前账号的专用目录内。 */
  private recordPath(identity: ShareIdentity, key: string): string {
    const digest = createHash('sha256').update(key).digest('hex')

    return path.join(identity.home, 'desktop-artifact-shares', `${digest}.json`)
  }

  /** 待确认上传保留原 ID，网络超时后重试不会产生另一条公开链接。 */
  private pendingPath(identity: ShareIdentity, key: string): string {
    return `${this.recordPath(identity, key)}.pending`
  }

  /** 从磁盘恢复尚未确认的分享 ID。 */
  private async readPending(identity: ShareIdentity, key: string): Promise<PendingShare | null> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.pendingPath(identity, key), 'utf8'))

      if (!value || typeof value !== 'object' || (value as { key?: unknown }).key !== key) {return null}
      const id = (value as { shareId?: unknown }).shareId

      return typeof id === 'string' && SHARE_ID.test(id) ? value as PendingShare : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return null}
      throw error
    }
  }

  /** 只接受自身保存的有效记录，不信任损坏或手工改写的元数据。 */
  private async read(identity: ShareIdentity, key: string): Promise<ArtifactShareRecord | null> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.recordPath(identity, key), 'utf8'))

      if (!value || typeof value !== 'object') {return null}
      const record = value as ArtifactShareRecord

      if (record.key !== key || !SHARE_ID.test(record.shareId) || !/^https:\/\//.test(record.url)) {return null}

      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return null}
      throw error
    }
  }

  /** 原子保存链接，防止崩溃时留下截断的 JSON。 */
  private async write(identity: ShareIdentity, record: ArtifactShareRecord): Promise<void> {
    const destination = this.recordPath(identity, record.key)
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`

    try {
      await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
      await fs.rename(temporary, destination)
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }

  /** 查询当前账号下某个产物的分享状态。 */
  async inspect(query: string | { shareId: string }): Promise<ArtifactShareRecord | null> {
    const identity = this.identity()

    if (typeof query !== 'string') {
      if (!query || typeof query.shareId !== 'string' || !SHARE_ID.test(query.shareId)) {
        throw new Error('分享标识无效。')
      }

      return (await this.records(identity)).find(record => record.shareId === query.shareId) ?? null
    }

    const key = query
    if (!key || key.length > 2048) {
      throw new Error('产物标识无效。')
    }

    return this.read(identity, key)
  }

  private now(): number {return (this.deps.now ?? Date.now)()}

  private assertIdentity(expected: ShareIdentity): void {
    const current = this.identity()
    if (current.accountId !== expected.accountId || current.home !== expected.home || current.token !== expected.token) {
      throw new Error('账号已切换，请重新确认分享状态。')
    }
  }

  private async records(identity: ShareIdentity): Promise<ArtifactShareRecord[]> {
    const directory = path.join(identity.home, 'desktop-artifact-shares')
    let entries: string[]
    try {entries = await fs.readdir(directory)} catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return []}
      throw error
    }
    const records: ArtifactShareRecord[] = []
    for (const name of entries.filter(name => /^(?:[a-f0-9]{64}|archive-[A-Za-z0-9_-]{16,64})\.json$/.test(name))) {
      let value: ArtifactShareRecord
      try {value = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))} catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {continue}
        throw error
      }
      if (typeof value?.key === 'string' && path.basename(this.recordPath(identity, value.key)) === name) {
        const record = await this.read(identity, value.key)
        if (record) {records.push(record)}
      } else if (value?.deletedAt && SHARE_ID.test(value.shareId) && name === `archive-${value.shareId}.json` && /^https:\/\//.test(value.url)) {
        records.push(value)
      }
    }
    return records
  }

  /** 修改期限不重新上传内容，保持同一链接；已删除的链接不能复活。 */
  async setExpiration(key: string, expectedShareId: string, ttlDays: number): Promise<ArtifactShareRecord> {
    const identity = this.identity()
    if (typeof key !== 'string' || !key || key.length > 2048 || !SHARE_ID.test(expectedShareId)) {
      throw new Error('分享标识无效。')
    }
    const expiresAt = artifactShareDeadline(ttlDays, this.now())
    return this.exclusive(identity, key, async () => {
      const record = await this.read(identity, key)
      if (!record || record.shareId !== expectedShareId || record.deletedAt) {
        throw new Error('分享已取消或状态已变化，请重新确认。')
      }
      const next = { ...record, expiresAt, cleanupError: undefined, updatedAt: new Date(this.now()).toISOString() }
      await this.write(identity, next)
      this.deps.changed?.(key)
      return next
    })
  }

  private async deleteExpired(identity: ShareIdentity, record: ArtifactShareRecord): Promise<void> {
    try {
      await deleteSharedPage(this.deps.request ?? fetch, identity.token, record.shareId)
      await this.write(identity, { ...record, deletedAt: new Date(this.now()).toISOString(), cleanupError: undefined })
    } catch (error) {
      await this.write(identity, { ...record, cleanupError: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      this.deps.changed?.(record.key)
    }
  }

  /** 启动补清理及定时重试共用同一路径，删除成功前保留持久记录。 */
  async cleanupExpired(): Promise<{ attempted: number; failed: number }> {
    const result = { attempted: 0, failed: 0 }
    if (!this.deps.identity()) {return result}
    const identity = this.identity()
    for (const candidate of await this.records(identity)) {
      if (candidate.deletedAt || !artifactShareExpired(candidate, this.now())) {continue}
      await this.exclusive(identity, candidate.key, async () => {
        const current = await this.read(identity, candidate.key)
        if (!current || current.deletedAt || !artifactShareExpired(current, this.now())) {return}
        result.attempted += 1
        try {await this.deleteExpired(identity, current)} catch {result.failed += 1}
      })
    }
    await this.cleanupPending(identity, result)
    return result
  }

  private async cleanupPending(identity: ShareIdentity, result: { attempted: number; failed: number }): Promise<void> {
    const directory = path.join(identity.home, 'desktop-artifact-shares')
    let names: string[]
    try {names = await fs.readdir(directory)} catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return}
      throw error
    }
    for (const name of names.filter(name => /^[a-f0-9]{64}\.json\.pending$/.test(name))) {
      let candidate: PendingShare
      try {candidate = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))} catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {continue}
        throw error
      }
      if (typeof candidate?.key !== 'string' || path.basename(this.pendingPath(identity, candidate.key)) !== name) {continue}
      await this.exclusive(identity, candidate.key, async () => {
        const pending = await this.readPending(identity, candidate.key)
        if (!pending || !artifactShareExpired(pending, this.now())) {return}
        if ((await this.read(identity, pending.key))?.shareId === pending.shareId) {
          await fs.rm(this.pendingPath(identity, pending.key), { force: true })
          return
        }
        result.attempted += 1
        try {
          await deleteSharedPage(this.deps.request ?? fetch, identity.token, pending.shareId)
          await fs.rm(this.pendingPath(identity, pending.key), { force: true })
        } catch {result.failed += 1}
      })
    }
  }

  /** 串行处理同一账号和产物的网络操作，避免旧版本覆盖新版本。 */
  private async exclusive<T>(identity: ShareIdentity, key: string, action: () => Promise<T>): Promise<T> {
    const slot = `${identity.accountId}:${identity.home}:${key}`
    const preceding = this.pending.get(slot) ?? Promise.resolve()
    const running = preceding.catch(() => undefined).then(() => {
      this.assertIdentity(identity)

      return action()
    })
    this.pending.set(slot, running)

    try {
      return await running
    } finally {
      if (this.pending.get(slot) === running) {this.pending.delete(slot)}
    }
  }

  /** 将 HTML 快照发布到固定网关；相同内容复用原链接。 */
  async publish(input: ArtifactSharePublishInput): Promise<ArtifactShareRecord> {
    const identity = this.identity()

    if (!input?.key || input.key.length > 2048 || typeof input.html !== 'string' || typeof input.title !== 'string') {
      throw new Error('分享内容无效。')
    }

    const bytes = Buffer.from(input.html, 'utf8')

    if (!bytes.length || bytes.length > MAX_BYTES) {throw new Error('网页快照为空或超过 2 MB。')}
    const hash = createHash('sha256').update(bytes).digest('hex')

    return this.exclusive(identity, input.key, async () => {
      new ArtifactOriginStore(identity.home).assertPublishable(input.source, input.html)
      const existing = await this.read(identity, input.key)

      const now = this.now()
      const active = existing && artifactShareActive(existing, now) ? existing : null
      const requestedDeadline = input.ttlDays === undefined ? undefined : artifactShareDeadline(input.ttlDays, now)

      if (active?.hash === hash && requestedDeadline === undefined) {return active}
      if (existing && !active) {
        if (!existing.deletedAt) {await this.deleteExpired(identity, existing)}
        await fs.copyFile(this.recordPath(identity, input.key), path.join(identity.home, 'desktop-artifact-shares', `archive-${existing.shareId}.json`))
      }
      const pending = active ? null : await this.readPending(identity, input.key)
      if (pending && artifactShareExpired(pending, now)) {
        await deleteSharedPage(this.deps.request ?? fetch, identity.token, pending.shareId)
        await fs.rm(this.pendingPath(identity, input.key), { force: true })
      }
      const recoverable = pending && !artifactShareExpired(pending, now) ? pending : null
      const shareId = active?.shareId ?? recoverable?.shareId ?? randomBytes(24).toString('base64url')
      const expiresAt = requestedDeadline ?? (active ? active.expiresAt ?? null : recoverable?.expiresAt ?? artifactShareDeadline(1, now))

      if (!active) {
        const pendingPath = this.pendingPath(identity, input.key)
        await fs.mkdir(path.dirname(pendingPath), { recursive: true, mode: 0o700 })
        await fs.writeFile(pendingPath, JSON.stringify({ key: input.key, shareId, expiresAt }), { mode: 0o600 })
      }

      const url = await uploadShareHtml(this.deps.request ?? fetch, identity.token, shareId, bytes)

      const record: ArtifactShareRecord = {
        key: input.key, shareId, url, title: input.title.slice(0, 200), hash,
        version: (active?.version ?? 0) + 1, updatedAt: new Date(this.now()).toISOString(), expiresAt
      }

      this.assertIdentity(identity)
      await this.write(identity, record)
      await fs.rm(this.pendingPath(identity, input.key), { force: true })
      this.deps.changed?.(input.key)

      return record
    })
  }

  /** 网关确认删除后才移除本地记录，失败时保留可重试链接。 */
  async revoke(key: string, expectedShareId?: string): Promise<void> {
    const identity = this.identity()

    if (!key || key.length > 2048) {throw new Error('产物标识无效。')}
    await this.exclusive(identity, key, async () => {
      const record = await this.read(identity, key)

      if (!record) {return}
      if (expectedShareId !== undefined && record.shareId !== expectedShareId) {
        throw new Error('分享状态已变化，请重新确认。')
      }

      await deleteSharedPage(this.deps.request ?? fetch, identity.token, record.shareId)
      await fs.rm(this.recordPath(identity, key))
      this.deps.changed?.(key)
    })
  }
}
