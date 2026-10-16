import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type {
  ConversationShareOwner,
  ConversationShareRecord,
  ConversationShareRequest,
  ConversationSnapshot,
  PreparedConversationShare
} from '../../../shared/src/conversation-share'
import type { ShareIdentity } from '../artifact-share/service'
import { writeSecretFileAtomic } from '../hardening'
import { deleteSharedPage, uploadShareHtml } from '../share-gateway'

const MAX_HTML_BYTES = 2 * 1024 * 1024
const DIGEST = /^[a-f0-9]{64}$/

const CSP =
  "default-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"

interface Prepared {
  accountId: string
  home: string
  owner: ConversationShareOwner
  request: ConversationShareRequest
  snapshot: ConversationSnapshot
  expires: number
  controller: AbortController
}

export interface ConversationShareDependencies {
  identity: () => ShareIdentity | null
  readSnapshot: (owner: ConversationShareOwner, request: ConversationShareRequest) => Promise<ConversationSnapshot>
  readImage?: (owner: ConversationShareOwner, sessionId: string, path: string) => Promise<{ dataUrl: string }>
  request?: typeof fetch
}

/** 规范化固定的后端归属字段，避免属性顺序和未声明字段改变幂等身份。 */
function normalizeOwner(owner: ConversationShareOwner): ConversationShareOwner {
  return { connectionId: owner?.connectionId || undefined, profile: owner?.profile || undefined }
}

/** 只接受独立静态文档，并在最前面的 head 中加入不可放宽的浏览器内容策略。 */
function staticHtml(html: string): Buffer {
  if (
    typeof html !== 'string' ||
    !/^<!doctype html>\s*<html[^>]*>\s*<head>/i.test(html) ||
    /<(?:script|iframe|frame|object|embed|form|base)\b/i.test(html) ||
    /<meta\b[^>]*http-equiv/i.test(html)
  ) {
    throw new Error('分享页面不是完整的静态文档。')
  }

  const secured = html.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="${CSP}">`)
  const bytes = Buffer.from(secured, 'utf8')

  if (!bytes.length || bytes.length > MAX_HTML_BYTES) {
    throw new Error('分享页面超过 2 MB，未发布截断内容。')
  }

  return bytes
}

/** 会话分享采用不可变快照；主进程向所属后端核验身份，不使用页面自报的快照证明。 */
export class ConversationShareService {
  private readonly prepared = new Map<string, Prepared>()
  private readonly operations = new Map<string, Promise<unknown>>()

  /** 注入主进程登录身份及固定快照接口，测试仍执行真实文件存储。 */
  constructor(private readonly deps: ConversationShareDependencies) {}

  /** 每次操作绑定当前账号，登录失效时不能继续发布或读取其他账号记录。 */
  private identity(): ShareIdentity {
    const identity = this.deps.identity()

    if (!identity?.accountId || !identity.home || !identity.token) {
      throw new Error('请先登录后再分享。')
    }

    return identity
  }

  /** 异步步骤后复核账号和 Home，切换后的迟到结果不能落入另一个账号。 */
  private assertOwner(identity: Pick<ShareIdentity, 'accountId' | 'home'>): void {
    const current = this.identity()

    if (current.accountId !== identity.accountId || current.home !== identity.home) {
      throw new Error('账号已切换，请重新准备分享。')
    }
  }

  /** 不同快照分开保存，文件名只使用主进程计算的固定长度摘要。 */
  private recordPath(identity: ShareIdentity, key: string): string {
    if (!DIGEST.test(key)) {
      throw new Error('分享记录标识无效。')
    }

    return path.join(identity.home, 'desktop-conversation-shares', `${key}.json`)
  }

  /** 缺失记录可以新建，损坏或无法读取的记录不能被当作尚未上传而覆盖。 */
  private async read(identity: ShareIdentity, key: string): Promise<ConversationShareRecord | null> {
    try {
      const record = JSON.parse(await fs.readFile(this.recordPath(identity, key), 'utf8')) as ConversationShareRecord

      if (
        record.key !== key ||
        !/^[a-f0-9]{48}$/.test(record.shareId) ||
        !DIGEST.test(record.snapshotId) ||
        !['pending', 'published', 'revoked'].includes(record.state)
      ) {
        throw new Error('分享记录损坏。')
      }

      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }

      throw error
    }
  }

  /** 原子保存稳定 shareId，服务端成功但本地确认失败时下次仍重试同一个对象。 */
  private async write(identity: ShareIdentity, record: ConversationShareRecord): Promise<void> {
    this.assertOwner(identity)
    const file = this.recordPath(identity, record.key)
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    this.assertOwner(identity)
    writeSecretFileAtomic(file, JSON.stringify(record))
  }

  /** 同一账号的同一个快照串行发布和撤销，重复点击不创建多条记录。 */
  private async exclusive<T>(identity: ShareIdentity, key: string, action: () => Promise<T>): Promise<T> {
    const operationKey = `${identity.accountId}:${key}`
    const previous = this.operations.get(operationKey) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(action)
    this.operations.set(operationKey, operation)

    try {
      return await operation
    } finally {
      if (this.operations.get(operationKey) === operation) {
        this.operations.delete(operationKey)
      }
    }
  }

  /** 在公开前固定可信内容及来源，短期票据只存在内存，不暴露登录凭据。 */
  async prepare(owner: ConversationShareOwner, request: ConversationShareRequest): Promise<PreparedConversationShare> {
    const identity = this.identity()

    if (!request?.sessionId || request.sessionId.length > 256 || !['session', 'response'].includes(request.scope)) {
      throw new Error('请选择有效的会话或回复。')
    }

    const route = normalizeOwner(owner)
    const source = structuredClone(request)
    const snapshot = await this.deps.readSnapshot(route, source)
    this.assertOwner(identity)

    if (
      !snapshot?.document ||
      snapshot.document.schemaVersion !== 1 ||
      !DIGEST.test(snapshot.document.snapshotId) ||
      !DIGEST.test(snapshot.revision) ||
      !Array.isArray(snapshot.document.messages) ||
      snapshot.document.scope !== source.scope
    ) {
      throw new Error('后端未返回可信的完整快照。')
    }

    for (const [key, item] of this.prepared) {
      if (item.expires < Date.now() || item.accountId !== identity.accountId) {
        item.controller.abort()
        this.prepared.delete(key)
      }
    }

    if (this.prepared.size >= 8) {
      throw new Error('同时准备的分享过多，请关闭其他分享窗口后重试。')
    }

    const ticket = randomBytes(24).toString('hex')
    this.prepared.set(ticket, {
      accountId: identity.accountId,
      home: identity.home,
      owner: route,
      request: source,
      snapshot: structuredClone(snapshot),
      expires: Date.now() + 10 * 60_000,
      controller: new AbortController()
    })

    return { ticket, document: structuredClone(snapshot.document) }
  }

  /** 只读取可信快照登记的图片，通过原生文件接口路由到同一后端并核对字节摘要。 */
  async image(ticket: string, reference: string): Promise<string> {
    const prepared = this.prepared.get(ticket)

    if (!prepared || prepared.expires < Date.now() || prepared.controller.signal.aborted) {
      throw new Error('分享准备已失效。')
    }

    this.assertOwner(prepared)
    const asset = prepared.snapshot.document.assets?.find(item => item.reference === reference)

    if (!asset || !this.deps.readImage) {
      throw new Error('图片未在可信快照中登记。')
    }

    const { dataUrl } = await this.deps.readImage(prepared.owner, prepared.snapshot.sessionId, asset.path)
    this.assertOwner(prepared)

    if (prepared.controller.signal.aborted || typeof dataUrl !== 'string' || dataUrl.length > MAX_HTML_BYTES * 1.4) {
      throw new Error('图片准备已取消或超过大小限制。')
    }

    const encoded = dataUrl.match(/^data:image\/(?:png|jpeg|gif|webp|avif);base64,([a-zA-Z0-9+/=]+)$/)

    if (!encoded || createHash('sha256').update(Buffer.from(encoded[1], 'base64')).digest('hex') !== asset.hash) {
      throw new Error('图片内容已变化或格式不受支持，请重新准备分享。')
    }

    return dataUrl
  }

  /** 取消准备和网络请求；已经可能上传的对象保留待确认记录，不伪称撤销成功。 */
  cancel(ticket: string): void {
    this.prepared.get(ticket)?.controller.abort()
    this.prepared.delete(ticket)
  }

  /** 发布前再读所属后端；同一快照复用原链接，绝不以新 HTML 覆盖已发布页面。 */
  async publish(ticket: string, html: string): Promise<ConversationShareRecord> {
    const identity = this.identity()
    const prepared = this.prepared.get(ticket)

    if (!prepared || prepared.expires < Date.now() || prepared.controller.signal.aborted) {
      throw new Error('分享准备已失效，请重新打开分享窗口。')
    }

    this.assertOwner(prepared)

    const key = createHash('sha256')
      .update(
        JSON.stringify([
          identity.accountId,
          prepared.owner,
          prepared.request.sessionId,
          prepared.request.scope,
          prepared.snapshot.document.snapshotId
        ])
      )
      .digest('hex')

    return this.exclusive(identity, key, async () => {
      const latest = await this.deps.readSnapshot(prepared.owner, prepared.request)
      this.assertOwner(prepared)

      if (
        latest.revision !== prepared.snapshot.revision ||
        latest.document.snapshotId !== prepared.snapshot.document.snapshotId ||
        prepared.controller.signal.aborted
      ) {
        throw new Error('会话在准备期间发生变化或已取消，请重新分享。')
      }

      const existing = await this.read(identity, key)
      this.assertOwner(prepared)

      if (existing?.state === 'published') {
        return existing
      }

      let bytes = staticHtml(html)

      const record: ConversationShareRecord =
        existing?.state === 'pending'
          ? existing
          : {
              key,
              shareId: randomBytes(24).toString('hex'),
              snapshotId: latest.document.snapshotId,
              scope: prepared.request.scope,
              title: latest.document.title,
              createdAt: new Date().toISOString(),
              state: 'pending',
              owner: prepared.owner,
              sessionId: prepared.request.sessionId
            }

      const payloadPath = this.recordPath(identity, key).replace(/\.json$/, '.html')

      if (existing?.state === 'pending') {
        // 响应丢失后的重试必须使用首次上传的原始字节，不能借重试更新已有公网对象。
        bytes = await fs.readFile(payloadPath)

        if (bytes.length > MAX_HTML_BYTES) {
          throw new Error('待确认的分享页面损坏。')
        }
      } else {
        await fs.mkdir(path.dirname(payloadPath), { recursive: true, mode: 0o700 })
        this.assertOwner(prepared)
        writeSecretFileAtomic(payloadPath, bytes)
      }

      await this.write(identity, record)
      this.assertOwner(prepared)

      const url = await uploadShareHtml(
        this.deps.request ?? fetch,
        this.identity().token,
        record.shareId,
        bytes,
        prepared.controller.signal
      )

      this.assertOwner(prepared)

      if (prepared.controller.signal.aborted) {
        throw new Error('分享已取消，上传结果待确认。')
      }

      const published: ConversationShareRecord = { ...record, state: 'published', url }
      await this.write(identity, published)

      return published
    })
  }

  /** 列出当前账号与精确后端、profile、会话相符的本机记录，不宣称跨设备同步。 */
  async list(owner: ConversationShareOwner, sessionId: string): Promise<ConversationShareRecord[]> {
    const identity = this.identity()
    const directory = path.dirname(this.recordPath(identity, '0'.repeat(64)))
    let names: string[]

    try {
      names = await fs.readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }

      throw error
    }

    if (names.length > 10000) {
      throw new Error('本机分享记录过多，无法完整读取。')
    }

    const records = await Promise.all(
      names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => this.read(identity, name.slice(0, -5)))
    )

    this.assertOwner(identity)

    return records
      .filter((record): record is ConversationShareRecord =>
        Boolean(
          record &&
          record.sessionId === sessionId &&
          JSON.stringify(normalizeOwner(record.owner)) === JSON.stringify(normalizeOwner(owner))
        )
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** 只有当前账号记录能撤销，删除失败仍保留原状态和可重试入口。 */
  async revoke(key: string): Promise<void> {
    const identity = this.identity()
    await this.exclusive(identity, key, async () => {
      const record = await this.read(identity, key)

      if (!record || record.state === 'revoked') {
        return
      }

      this.assertOwner(identity)
      await deleteSharedPage(this.deps.request ?? fetch, identity.token, record.shareId)
      this.assertOwner(identity)
      await this.write(identity, { ...record, state: 'revoked' })
    })
  }
}
