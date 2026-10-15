import type { PDFPageProxy } from 'pdfjs-dist'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

const LONG_EDGE = 1600
const CACHE_PAGES = 6

export interface PdfPageSize {
  width: number
  height: number
}

export interface PdfPages {
  readonly pages: readonly PdfPageSize[]
  /** 页码从 1 开始；返回受本阅读器管理的图片地址，淘汰或关闭后失效。 */
  renderPage: (number: number) => Promise<string>
  dispose: () => Promise<void>
}

/** 只读取已提供的字节；Worker 与辅助资源均来自随应用发布的本机资源。 */
export async function openPdfPages(bytes: Uint8Array): Promise<PdfPages> {
  GlobalWorkerOptions.workerSrc = workerUrl
  const assets = new URL('pdfjs/', document.baseURI)

  const task = getDocument({
    data: bytes.slice(),
    cMapUrl: new URL('cmaps/', assets).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', assets).href,
    wasmUrl: new URL('wasm/', assets).href,
    iccUrl: new URL('iccs/', assets).href,
    useSystemFonts: true,
    stopAtErrors: true
  })

  try {
    const pdf = await task.promise
    const pages: PdfPageSize[] = []

    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number)
      const { width, height } = page.getViewport({ scale: 1 })
      page.cleanup()

      if (!Number.isFinite(width + height) || width <= 0 || height <= 0) {
        throw { code: 'unsupported' }
      }

      pages.push({ width, height })
    }

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

        const size = pages[number - 1]
        const viewport = page.getViewport({ scale: LONG_EDGE / Math.max(size.width, size.height) })
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
