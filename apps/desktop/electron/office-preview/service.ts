import fs from 'node:fs/promises'
import path from 'node:path'

import {
  OFFICE_CONVERTER_ORDER,
  OFFICE_PDF_MAX_BYTES,
  OFFICE_SOURCE_MAX_BYTES,
  OFFICE_TIMEOUT_MS,
  officeDocumentKind,
  type OfficePreviewFailureCode,
  type OfficePreviewResult
} from '../../../shared/src/office-preview'
import { resolveReadableFileForIpc } from '../hardening'

import { officeCacheKey, OfficePreviewCache } from './cache'
import { convertCom } from './convert-com'
import { convertLibreOffice } from './convert-libreoffice'
import { createOfficeDetector } from './detect'
import { OfficePreviewJobs } from './jobs'

interface ServiceDeps {
  detector: ReturnType<typeof createOfficeDetector>
  com: typeof convertCom
  libreoffice: typeof convertLibreOffice
  now: () => number
  active: () => boolean
}

const jobs = new OfficePreviewJobs<OfficePreviewResult>()
const detector = createOfficeDetector()

const FAILURES = new Set<OfficePreviewFailureCode>([
  'too_large',
  'timeout',
  'convert_failed',
  'unavailable',
  'unsupported',
  'not_found'
])

/** 内部错误只归为有限原因代码，不把异常、路径或凭据传给页面。 */
function failure(error: unknown): OfficePreviewResult {
  const code = (error as NodeJS.ErrnoException)?.code

  return {
    ok: false,
    code:
      code === 'ENOENT' || code === 'ENOTDIR'
        ? 'not_found'
        : code === 'EFBIG'
          ? 'too_large'
          : FAILURES.has(code as OfficePreviewFailureCode)
            ? (code as OfficePreviewFailureCode)
            : 'convert_failed'
  }
}

/** 发布前唯一的产物检查：普通文件、非空、不超过上限、以 PDF 文件头开头；合格返回 null。 */
async function pdfFailure(pdfPath: string): Promise<OfficePreviewFailureCode | null> {
  try {
    const stat = await fs.lstat(pdfPath)

    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) {
      return 'convert_failed'
    }

    if (stat.size > OFFICE_PDF_MAX_BYTES) {
      return 'too_large'
    }

    const handle = await fs.open(pdfPath, 'r')
    const header = Buffer.alloc(5)

    try {
      await handle.read(header, 0, 5, 0)
    } finally {
      await handle.close()
    }

    return header.toString() === '%PDF-' ? null : 'convert_failed'
  } catch {
    return 'convert_failed'
  }
}

/** 固定账号缓存，只把原文件的英文副本交给转换器，全进程串行转换。 */
export function createOfficePreviewService(desktopState: string, overrides: Partial<ServiceDeps> = {}) {
  const deps: ServiceDeps = {
    detector,
    com: convertCom,
    libreoffice: convertLibreOffice,
    now: Date.now,
    active: () => true,
    ...overrides
  }

  const cache = new OfficePreviewCache(desktopState)

  /** 先复用正式读文件边界，再取真实路径和版本，不允许页面指定账号或缓存位置。 */
  async function sourceInfo(filePath: string) {
    const source = await resolveReadableFileForIpc(filePath, {
      maxBytes: OFFICE_SOURCE_MAX_BYTES,
      purpose: 'Office preview'
    })

    return {
      ...source,
      version: officeCacheKey({ realPath: source.realPath, size: source.stat.size, mtimeMs: source.stat.mtimeMs })
    }
  }

  /** 转换成功还要验证 PDF；失败只在安全收尾后尝试下一厂家。请求方离开时传入的 signal 会取消，排队中的转换随之跳过。 */
  async function convert(filePath: string, signal?: AbortSignal, background = false): Promise<OfficePreviewResult> {
    try {
      if (!deps.active() || signal?.aborted) {
        return { ok: false, code: 'unavailable' }
      }

      const kind = officeDocumentKind(filePath)

      if (!kind) {
        return { ok: false, code: 'unsupported' }
      }

      const source = await sourceInfo(filePath)
      // 已准备好的文件不排在另一份长文档后；实际转换仍共用唯一队列。
      const ready = await cache.get(source.version)

      if (ready) {
        return { ok: true, pdf: ready.pdf, version: ready.version, converter: ready.converter }
      }

      /** 轮到这个请求时执行的一次转换；排队期间没人再等就不会执行。 */
      const work = async (): Promise<OfficePreviewResult> => {
        if (!deps.active()) {
          return { ok: false, code: 'unavailable' }
        }

        // 排队期间文件可能又被保存过：以开始转换时的版本为准，转换并缓存最新内容。
        const current = await sourceInfo(filePath)
        const cached = await cache.get(current.version)

        if (cached) {
          return { ok: true, pdf: cached.pdf, version: cached.version, converter: cached.converter }
        }

        const deadline = deps.now() + OFFICE_TIMEOUT_MS
        const available = (await deps.detector.get())[kind]
        let code: OfficePreviewFailureCode = 'unavailable'
        let safe = true
        const work = await cache.createWorkDirectory()

        try {
          const copy = path.join(work, 'source' + path.extname(filePath).toLowerCase())
          await fs.copyFile(current.realPath, copy)

          if (
            (await sourceInfo(filePath)).version !== current.version ||
            (await fs.stat(copy)).size !== current.stat.size
          ) {
            return { ok: false, code: 'convert_failed' }
          }

          const candidates = OFFICE_CONVERTER_ORDER.flatMap(provider =>
            available.filter(program => program.provider === provider)
          )

          for (const [index, program] of candidates.entries()) {
            if (!deps.active()) {
              return { ok: false, code: 'unavailable' }
            }

            const provider = program.provider

            const remaining = deadline - deps.now()

            if (remaining <= 1) {
              return { ok: false, code: 'timeout' }
            }

            const attempt = path.join(work, `${provider}-${index}`)
            await fs.mkdir(attempt)
            safe = false

            const result =
              program.provider === 'libreoffice'
                ? await deps.libreoffice(program, copy, attempt, remaining)
                : await deps.com(program, copy, attempt, remaining)

            safe = result.ok === true || result.cleanupSafe

            if (result.ok === false) {
              if (result.code !== 'unavailable' || code === 'unavailable') {
                code = result.code
              }

              if (!safe) {
                return { ok: false, code }
              }

              if (result.code === 'unavailable') {
                deps.detector.invalidate()
              }

              continue
            }

            const invalid = await pdfFailure(result.pdfPath)

            if (invalid) {
              code = invalid

              continue
            }

            await cache.publish(current.version, result.pdfPath, provider)
            const published = await cache.get(current.version)

            return published
              ? { ok: true, pdf: published.pdf, version: published.version, converter: published.converter }
              : { ok: false, code: 'convert_failed' }
          }

          return { ok: false, code }
        } finally {
          // 清理出错（文件仍被占用等）不改变已经得到的结果；没删掉的临时目录由之后的淘汰回收。
          await (safe ? cache.discardWorkDirectory(work) : cache.preserveWorkDirectory(work)).catch(() => undefined)
        }
      }

      return await jobs.run(cache.directory, source.version, work, signal, background)
    } catch (error) {
      return failure(error)
    }
  }

  return { convert }
}
