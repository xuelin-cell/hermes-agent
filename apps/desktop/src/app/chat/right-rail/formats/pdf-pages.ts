import type { PDFPageProxy } from 'pdfjs-dist'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

import { PDF_RESOURCE_OPTIONS } from '../pdf-resources'

const LONG_EDGE = 1600
const CACHE_PAGES = 30

export interface PdfPageSize {
  width: number
  height: number
}

export interface PdfPages {
  /** 只量第一页；其余页先沿用它作为占位比例，画图时按各页真实尺寸。 */
  readonly pages: readonly PdfPageSize[]
  /** 页码从 1 开始；返回受本阅读器管理的图片地址，淘汰或关闭后失效。 */
  renderPage: (number: number) => Promise<string>
  /** 命中时用于首次绘制，避免回看缓存页先闪一次加载占位。 */
  cachedPage: (number: number) => string | undefined
  dispose: () => Promise<void>
}

/** 页面尺寸必须是有限正数，损坏的页面框不能用来分配画布。 */
function validSize({ width, height }: PdfPageSize) {
  return Number.isFinite(width + height) && width > 0 && height > 0
}

/** 只读取已提供的字节；Worker 与辅助资源均来自随应用发布的本机资源。 */
export async function openPdfPages(bytes: Uint8Array): Promise<PdfPages> {
  const task = getDocument({
    data: bytes.slice(),
    ...PDF_RESOURCE_OPTIONS,
    useSystemFonts: true,
    stopAtErrors: true
  })

  try {
    const pdf = await task.promise
    const first = await pdf.getPage(1)
    const size = first.getViewport({ scale: 1 })
    first.cleanup()

    if (!validSize(size)) {
      throw { code: 'unsupported' }
    }

    // 几百页的演示文稿逐页读尺寸要等很久；幻灯片通常同尺寸，先显示，个别不同的页留白边。
    const pages: PdfPageSize[] = Array.from({ length: pdf.numPages }, () => ({
      width: size.width,
      height: size.height
    }))

    let closed = false
    let disposal: Promise<void> | undefined
    let queue: Promise<unknown> = Promise.resolve()
    const cache = new Map<number, string>()
    const pending = new Map<number, Promise<string>>()

    /** 每份文档串行画图；关闭后不再创建地址，成功或失败都归还画布和页面资源。 */
    async function render(number: number) {
      if (closed) {
        throw { code: 'unavailable' }
      }

      let page: PDFPageProxy | undefined
      const canvas = document.createElement('canvas')

      try {
        page = await pdf.getPage(number)

        if (closed) {
          throw { code: 'unavailable' }
        }

        const own = page.getViewport({ scale: 1 })

        if (!validSize(own)) {
          throw { code: 'unsupported' }
        }

        const viewport = page.getViewport({ scale: LONG_EDGE / Math.max(own.width, own.height) })
        canvas.width = Math.max(1, Math.round(viewport.width))
        canvas.height = Math.max(1, Math.round(viewport.height))
        await page.render({ canvas, viewport }).promise
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))

        if (closed) {
          throw { code: 'unavailable' }
        }

        if (!blob) {
          throw { code: 'unsupported' }
        }

        const url = URL.createObjectURL(blob)
        cache.set(number, url)

        if (cache.size > CACHE_PAGES) {
          const oldest = cache.keys().next().value!
          URL.revokeObjectURL(cache.get(oldest)!)
          cache.delete(oldest)
        }

        return url
      } finally {
        canvas.width = canvas.height = 0
        page?.cleanup()
      }
    }

    return {
      pages,
      /** 只读当前可用地址，随后 renderPage 会更新 LRU 并为显示器复制独立图片。 */
      cachedPage: number => cache.get(number),
      /** 同页并发共用一次任务，命中时更新最近使用顺序，失败不阻塞下一页。 */
      renderPage(number) {
        if (closed) {
          return Promise.reject({ code: 'unavailable' })
        }

        if (!Number.isInteger(number) || number < 1 || number > pages.length) {
          return Promise.reject({ code: 'unsupported' })
        }

        const cached = cache.get(number)

        if (cached) {
          cache.delete(number)
          cache.set(number, cached)

          return Promise.resolve(cached)
        }

        const existing = pending.get(number)

        if (existing) {
          return existing
        }

        const result = queue.then(() => render(number))
        queue = result.then(
          () => undefined,
          () => undefined
        )
        pending.set(number, result)
        void result.then(
          () => pending.delete(number),
          () => pending.delete(number)
        )

        return result
      },
      /** 幂等关闭：立刻撤销缓存，终止 Worker，并等候正在编码的页面归还资源。 */
      dispose() {
        if (!disposal) {
          closed = true

          for (const url of cache.values()) {
            URL.revokeObjectURL(url)
          }

          cache.clear()
          disposal = task.destroy().then(async () => {
            await queue
          })
        }

        return disposal
      }
    }
  } catch {
    await task.destroy()
    throw { code: 'unsupported' }
  }
}
