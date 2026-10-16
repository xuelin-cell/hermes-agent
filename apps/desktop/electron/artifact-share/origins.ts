import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { composeArtifactHtml } from '../../../shared/src/artifact-share'
import type { ArtifactShareEligibility, ArtifactShareSource } from '../../../shared/src/artifact-share'
import { writeSecretFileAtomic } from '../hardening'

interface FileOrigin {
  hash: string
  origin: 'model_created' | 'user_upload_derived'
}

interface SessionOrigin {
  version: 1
  sessionId: string
  profileHome: string
  verified: boolean
  hasUploads: boolean
  parentSessionId?: string
  files: Record<string, FileOrigin>
  inline: string[]
}

export interface OriginEvent {
  sessionId: string
  profileHome: string
  type: 'context' | 'files' | 'inline'
  fresh?: boolean
  hasUploads?: boolean
  parentSessionId?: string
  files?: Array<{ path: string; hash: string; replace?: boolean }>
  contents?: string[]
}

/** 计算与 Python 插件一致的内容摘要，文件名和目录不参与来源判定。 */
export function originHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** 在当前账号内保存插件观测到的来源事实，Renderer 只能追加上传禁用标记。 */
export class ArtifactOriginStore {
  /** 每次操作使用调用时解析的账号目录，避免跨账号共享缓存。 */
  constructor(private readonly home: string) {}

  /** 将不可信会话标识映射为固定目录下的文件名。 */
  private filename(sessionId: string): string {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) {
      throw new Error('产物会话标识无效。')
    }

    return path.join(this.home, 'desktop-artifact-origins', `${originHash(sessionId)}.json`)
  }

  /** 来源记录缺失时保持未知，不把历史文件自动升级为可信产物。 */
  private read(sessionId: string): SessionOrigin {
    const filename = this.filename(sessionId)

    if (fs.existsSync(filename)) {
      const record = JSON.parse(fs.readFileSync(filename, 'utf8')) as SessionOrigin

      if (record.version !== 1 || record.sessionId !== sessionId || typeof record.verified !== 'boolean' ||
        typeof record.hasUploads !== 'boolean' || !record.files || !Array.isArray(record.inline)) {
        throw new Error('产物来源记录无效。')
      }

      return record
    }

    return { version: 1, sessionId, profileHome: '', verified: false, hasUploads: false, files: {}, inline: [] }
  }

  /** 原子落盘，不与异步上传共用临时状态。 */
  private write(record: SessionOrigin): void {
    const filename = this.filename(record.sessionId)
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
    writeSecretFileAtomic(filename, JSON.stringify(record), { encoding: 'utf8' })
  }

  /** 仅接受本账号或其明确 profile 的插件事件，拒绝同名会话串用其他 profile。 */
  record(event: OriginEvent): void {
    const home = fs.realpathSync(this.home)
    const profile = fs.realpathSync(event.profileHome)
    const relative = path.relative(home, profile)
    const parts = relative.split(path.sep)

    if (relative && (parts.length !== 2 || parts[0] !== 'profiles' || !parts[1] || parts[1] === '..')) {
      throw new Error('产物来源不属于当前账号。')
    }

    const record = this.read(event.sessionId)

    if (record.profileHome && record.profileHome !== profile) {
      throw new Error('产物会话的 profile 不匹配。')
    }

    record.profileHome = profile

    if (event.parentSessionId && event.parentSessionId !== event.sessionId) {
      record.parentSessionId ??= event.parentSessionId
    }

    const parent = record.parentSessionId ? this.read(record.parentSessionId) : null

    if (parent?.verified) {
      record.verified = true
      record.files = { ...parent.files, ...record.files }
      record.inline = [...new Set([...parent.inline, ...record.inline])].slice(-256)
    }

    if (event.type === 'context') {
      record.verified ||= event.fresh === true && !parent
      record.hasUploads ||= event.hasUploads === true
    } else if (record.verified) {
      for (const file of event.files ?? []) {
        const resolved = fs.realpathSync(file.path)
        const stat = fs.statSync(resolved)

        if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || originHash(fs.readFileSync(resolved)) !== file.hash) {
          continue
        }

        const previous = record.files[resolved]

        if (!file.replace && !previous) {
          continue
        }

        record.files[resolved] = {
          hash: file.hash,
          origin: record.hasUploads || previous?.origin === 'user_upload_derived' ? 'user_upload_derived' : 'model_created'
        }
      }

      for (const content of event.contents ?? []) {
        if (typeof content === 'string' && Buffer.byteLength(content) <= 2 * 1024 * 1024) {
          record.inline = [...new Set([...record.inline, originHash(content)])].slice(-256)
        }
      }
    }

    this.write(record)
  }

  /** 上传事实永久保留，删除附件或重启应用都不能解除此会话的发布限制。 */
  markUploaded(sessionId: string): void {
    const record = this.read(sessionId)
    record.hasUploads = true
    this.write(record)
  }

  /** 委派任务继承父会话的上传限制，不能通过新建子任务洗白来源。 */
  private sessionReason(record: SessionOrigin, seen = new Set<string>()): ArtifactShareEligibility['reason'] {
    if (record.hasUploads) {
      return 'user_upload'
    }

    if (seen.has(record.sessionId) || seen.size >= 16 || !record.verified) {
      return 'unknown_origin'
    }

    seen.add(record.sessionId)

    return record.parentSessionId ? this.sessionReason(this.read(record.parentSessionId), seen) : null
  }

  /** 文件必须仍匹配模型写出时的字节，未知、上传及派生来源默认拒绝。 */
  eligibility(source: ArtifactShareSource): ArtifactShareEligibility {
    const record = this.read(source?.sessionId)

    const reason = this.sessionReason(record)

    if (reason) {
      return { publishable: false, reason }
    }

    if (source.path) {
      const resolved = fs.realpathSync(source.path)
      const origin = record.files[resolved]

      if (!origin || origin.origin !== 'model_created') {
        return { publishable: false, reason: 'unknown_origin' }
      }

      const stat = fs.statSync(resolved)

      if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || originHash(fs.readFileSync(resolved)) !== origin.hash ||
        (source.hash && source.hash !== origin.hash)) {
        return { publishable: false, reason: 'content_changed' }
      }
    } else if (typeof source.content !== 'string' || !record.inline.includes(originHash(source.content))) {
      return { publishable: false, reason: 'unknown_origin' }
    }

    return { publishable: true, reason: null }
  }

  /** 在网络上传之前重新验证来源及快照，防止 UI 或模型绕过资格检查。 */
  assertPublishable(source: ArtifactShareSource, html: string): void {
    if (!this.eligibility(source).publishable) {
      throw new Error('只能分享来源已确认的模型产物；上传文件、派生产物和来源未知的文件不能发布。')
    }

    if (source.path) {
      if (!source.hash || (/\.html?$/i.test(source.path) && originHash(html) !== source.hash)) {
        throw new Error('分享快照与已确认的产物版本不一致。')
      }
    } else if (html !== composeArtifactHtml(source.content!)) {
      throw new Error('分享快照与模型生成的内容不一致。')
    }
  }
}
