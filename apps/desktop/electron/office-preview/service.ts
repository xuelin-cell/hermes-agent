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

  /** 转换成功还要验证 PDF；失败只在安全收尾后尝试下一厂家。 */
  async function convert(filePath: string): Promise<OfficePreviewResult> {
    try {
      if (!deps.active()) {
        return { ok: false, code: 'unavailable' }
      }

      const kind = officeDocumentKind(filePath)

      if (!kind) {
        return { ok: false, code: 'unsupported' }
      }

      const source = await sourceInfo(filePath)

      return await jobs.run(cache.directory, source.version, async () => {
        if (!deps.active()) {
          return { ok: false, code: 'unavailable' }
        }

        const current = await sourceInfo(filePath)

        if (current.version !== source.version) {
          return { ok: false, code: 'convert_failed' }
        }

        const cached = await cache.get(source.version)

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
          await fs.copyFile(source.realPath, copy)

          if (
            (await sourceInfo(filePath)).version !== source.version ||
            (await fs.stat(copy)).size !== source.stat.size
          ) {
            return { ok: false, code: 'convert_failed' }
          }

          for (const provider of OFFICE_CONVERTER_ORDER) {
            if (!deps.active()) {
              return { ok: false, code: 'unavailable' }
            }

            const program = available.find(candidate => candidate.provider === provider)

            if (!program) {
              continue
            }

            const remaining = deadline - deps.now()

            if (remaining <= 1) {
              return { ok: false, code: 'timeout' }
            }

            const attempt = path.join(work, provider)
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

            try {
              const stat = await fs.lstat(result.pdfPath)

              if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) {
                throw { code: 'convert_failed' }
              }

              if (stat.size > OFFICE_PDF_MAX_BYTES) {
                throw { code: 'too_large' }
              }

              const handle = await fs.open(result.pdfPath, 'r')
              const header = Buffer.alloc(5)

              try {
                await handle.read(header, 0, 5, 0)
              } finally {
                await handle.close()
              }

              if (header.toString() !== '%PDF-') {
                throw { code: 'convert_failed' }
              }
            } catch (error) {
              code = (error as NodeJS.ErrnoException)?.code === 'too_large' ? 'too_large' : 'convert_failed'

              continue
            }

            await cache.publish(source.version, result.pdfPath, provider)
            const published = await cache.get(source.version)

            return published
              ? { ok: true, pdf: published.pdf, version: published.version, converter: published.converter }
              : { ok: false, code: 'convert_failed' }
          }

          return { ok: false, code }
        } finally {
          if (safe) {
            await cache.discardWorkDirectory(work)
          } else {
            await cache.preserveWorkDirectory(work)
          }
        }
      })
    } catch (error) {
      return failure(error)
    }
  }

  return { convert }
}
