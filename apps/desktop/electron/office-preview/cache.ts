import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { OFFICE_CONVERTER_ORDER, OFFICE_PDF_MAX_BYTES, type OfficeConverter } from '../../../shared/src/office-preview'

const KEY_PATTERN = /^[a-f0-9]{64}$/
const WORK_PATTERN = /^job-[a-zA-Z0-9]{6}$/
const STALE_WORK_MS = 60 * 60 * 1000

export interface OfficeSourceFingerprint {
  realPath: string
  size: number
  mtimeMs: number
}

export interface OfficeCacheLimits {
  maxEntries: number
  maxBytes: number
}

interface CacheNote {
  converter: OfficeConverter
  convertedAt: number
}

interface CacheEntry extends CacheNote {
  directory: string
  bytes: number
  lastUsed: number
}

export interface CachedOfficePdf extends CacheNote {
  pdf: Uint8Array
  version: string
}

/** 文件真实路径、大小或修改时间变化时得到新版本；不把原路径写进缓存说明。 */
export function officeCacheKey(source: OfficeSourceFingerprint): string {
  return createHash('sha256')
    .update(JSON.stringify([source.realPath, source.size, source.mtimeMs]))
    .digest('hex')
}

/** 只认既有文件缺失；权限、磁盘和其它异常不能伪装成缓存未命中。 */
function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

/** 固定在当前账号 desktopState 下，缓存只存发布完成的 PDF 和转换说明。 */
export class OfficePreviewCache {
  readonly directory: string
  private prepared: Promise<void> | undefined
  private tail: Promise<void> = Promise.resolve()

  /** 账号目录由主进程提供；可注入小限额做测试，不增加用户配置项。 */
  constructor(
    desktopState: string,
    private limits: OfficeCacheLimits = { maxEntries: 30, maxBytes: 500 * 1024 * 1024 }
  ) {
    this.directory = path.resolve(desktopState, 'office-preview')
  }

  /** 首次使用建立缓存目录，清理旧临时目录并执行启动淘汰，不跟随目录联接；失败后下次调用重新准备。 */
  private ready(now = Date.now()): Promise<void> {
    if (!this.prepared) {
      const prepared = (async () => {
        await fs.mkdir(this.directory, { recursive: true })
        const stat = await fs.lstat(this.directory)

        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error('Invalid Office cache directory')
        }

        await this.pruneEntries(now)
      })()

      this.prepared = prepared
      // 一次失败（例如目录暂时不可用）不能让之后所有预览都失败；只作废自己这次准备。
      prepared.catch(() => {
        if (this.prepared === prepared) {
          this.prepared = undefined
        }
      })
    }

    return this.prepared
  }

  /** 串行读写和淘汰，避免读取最近使用时间或发布期间被同实例清理。 */
  private serial<R>(work: () => Promise<R>): Promise<R> {
    const result = this.tail.then(work)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )

    return result
  }

  /** 缓存键只能是正式摘要，不能通过路径参数访问账号目录之外的文件。 */
  private entryDirectory(key: string): string {
    if (!KEY_PATTERN.test(key)) {
      throw new Error('Invalid Office cache key')
    }

    return path.join(this.directory, key)
  }

  /** 删除仅限本缓存直属、名称受控的普通目录，拒绝联接和符号链接。 */
  private async removeOwned(directory: string): Promise<void> {
    const resolved = path.resolve(directory)
    const name = path.basename(resolved)

    if (path.dirname(resolved) !== this.directory || (!KEY_PATTERN.test(name) && !WORK_PATTERN.test(name))) {
      throw new Error('Office cache cleanup outside managed directory')
    }

    let stat

    try {
      stat = await fs.lstat(resolved)
    } catch (error) {
      if (isMissing(error)) {
        return
      }

      throw error
    }

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Invalid Office cache cleanup target')
    }

    await fs.rm(resolved, { recursive: true })
  }

  /** 半成品、坏说明或已丢失 PDF 视为未命中；其它读取错误保留给调用方处理。 */
  private async entry(key: string): Promise<CacheEntry | null> {
    const directory = this.entryDirectory(key)

    try {
      const [folder, pdf, note] = await Promise.all([
        fs.lstat(directory),
        fs.lstat(path.join(directory, 'doc.pdf')),
        fs.lstat(path.join(directory, 'note.json'))
      ])

      if (
        !folder.isDirectory() ||
        folder.isSymbolicLink() ||
        !pdf.isFile() ||
        pdf.isSymbolicLink() ||
        !note.isFile() ||
        note.isSymbolicLink() ||
        !pdf.size ||
        pdf.size > OFFICE_PDF_MAX_BYTES ||
        note.size > 1024
      ) {
        return null
      }

      const metadata = JSON.parse(await fs.readFile(path.join(directory, 'note.json'), 'utf8')) as CacheNote

      if (!metadata || !OFFICE_CONVERTER_ORDER.includes(metadata.converter) || !Number.isFinite(metadata.convertedAt)) {
        return null
      }

      return { ...metadata, directory, bytes: pdf.size + note.size, lastUsed: folder.mtimeMs }
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) {
        return null
      }

      throw error
    }
  }

  /** 缓存命中时刷新最近使用并返回字节，之后淘汰不会使返回内容失效。 */
  async get(key: string, now = Date.now()): Promise<CachedOfficePdf | null> {
    this.entryDirectory(key)
    await this.ready(now)

    return this.serial(async () => {
      const cached = await this.entry(key)

      if (!cached) {
        return null
      }

      const pdf = await fs.readFile(path.join(cached.directory, 'doc.pdf'))
      await fs.utimes(cached.directory, new Date(now), new Date(now))

      return { pdf, version: key, converter: cached.converter, convertedAt: cached.convertedAt }
    })
  }

  /** 转换使用独立英文临时目录，失败时由调用方清理，崩溃后启动回收。 */
  async createWorkDirectory(now = Date.now()): Promise<string> {
    await this.ready(now)

    return fs.mkdtemp(path.join(this.directory, 'job-'))
  }

  /** 只回收本账号自己建立的临时目录，保留用户原文件及其它账号缓存。 */
  async discardWorkDirectory(directory: string): Promise<void> {
    if (!WORK_PATTERN.test(path.basename(directory))) {
      throw new Error('Invalid Office work directory')
    }

    await this.ready()
    await this.serial(() => this.removeOwned(directory))
  }

  /** 收尾未确认的工作目录留作人工处理，启动时不按普通残留回收。 */
  async preserveWorkDirectory(directory: string): Promise<void> {
    if (path.dirname(path.resolve(directory)) !== this.directory || !WORK_PATTERN.test(path.basename(directory)) ||
      (await fs.lstat(directory)).isSymbolicLink()) {
      throw new Error('Invalid retained Office work directory')
    }

    await fs.writeFile(path.join(directory, 'retain'), 'cleanup-unconfirmed', { flag: 'wx' })
  }

  /** PDF 与说明先写入新目录，再原子发布；缓存中不保留转换源文件。调用方负责先检查 PDF。 */
  async publish(key: string, pdfPath: string, converter: OfficeConverter, now = Date.now()): Promise<void> {
    const destination = this.entryDirectory(key)
    await this.ready(now)

    await this.serial(async () => {
      if (await this.entry(key)) {
        await fs.utimes(destination, new Date(now), new Date(now))
        await this.pruneEntries(now, key)

        return
      }

      // 产物已由转换服务检查过，这里只负责原子发布。
      const staging = await this.createWorkDirectory(now)

      try {
        await fs.copyFile(pdfPath, path.join(staging, 'doc.pdf'))
        await fs.writeFile(path.join(staging, 'note.json'), JSON.stringify({ converter, convertedAt: now }), {
          flag: 'wx'
        })
        await fs.utimes(staging, new Date(now), new Date(now))
        await this.removeOwned(destination)
        await fs.rename(staging, destination)
        await this.pruneEntries(now, key)
      } finally {
        await this.removeOwned(staging)
      }
    })
  }

  /** 删除一项淘汰目标；被占用或无权限时跳过，下次淘汰再试，不让清理失败影响预览。 */
  private async tryRemove(directory: string): Promise<boolean> {
    try {
      await this.removeOwned(directory)

      return true
    } catch {
      return false
    }
  }

  /** 按最近使用淘汰份数与总量，始终保留最近一份；仅清理过期的受管临时目录，单项失败不中断。 */
  private async pruneEntries(now: number, protectedKey?: string): Promise<number> {
    const entries: CacheEntry[] = []
    let removed = 0

    for (const item of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!item.isDirectory() || item.isSymbolicLink()) {
        continue
      }

      const directory = path.join(this.directory, item.name)

      try {
        if (WORK_PATTERN.test(item.name)) {
          if (await this.isRetained(directory)) {
            continue
          }

          const stat = await fs.lstat(directory)

          if (now - stat.mtimeMs > STALE_WORK_MS && (await this.tryRemove(directory))) {
            removed++
          }
        } else if (KEY_PATTERN.test(item.name)) {
          const cached = await this.entry(item.name)

          if (cached) {
            entries.push(cached)
          }
        }
      } catch {
        // 读不了的单项（权限、占用）留到下次，不影响其它缓存的淘汰和本次预览。
        continue
      }
    }

    entries.sort(
      (a, b) =>
        Number(path.basename(b.directory) === protectedKey) - Number(path.basename(a.directory) === protectedKey) ||
        b.lastUsed - a.lastUsed
    )
    let bytes = 0
    let kept = 0

    for (const entry of entries) {
      if (!kept || (kept < this.limits.maxEntries && bytes + entry.bytes <= this.limits.maxBytes)) {
        kept++
        bytes += entry.bytes
      } else if (await this.tryRemove(entry.directory)) {
        removed++
      }
    }

    return removed
  }

  /** 收尾未确认而保留的工作目录带有 retain 标记，启动淘汰不回收。 */
  private async isRetained(directory: string): Promise<boolean> {
    try {
      await fs.lstat(path.join(directory, 'retain'))

      return true
    } catch (error) {
      if (isMissing(error)) {
        return false
      }

      throw error
    }
  }

  /** 对发布完成的缓存执行回收，文件正在转换时不发布半成品。 */
  async prune(now = Date.now()): Promise<number> {
    await this.ready(now)

    return this.serial(() => this.pruneEntries(now))
  }
}
