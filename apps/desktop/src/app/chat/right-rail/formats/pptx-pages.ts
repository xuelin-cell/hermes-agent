import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { loadPresentation, renderSlideToElement } from 'pptx-viewer'

import type { PdfPages, PdfPageSize } from './pdf-pages'

const LONG_EDGE = 1600
const CACHE_PAGES = 30
// pptx-viewer 0.2.2 加载时把内嵌字体写进主页面的这个样式块；幻灯片按图片显示用不到，留着会影响应用自身字体。
const EMBEDDED_FONT_STYLE = 'pptx-embedded-fonts'
// 表格单元格把字体名和颜色原样拼进 HTML 字符串，只能在绘制前清理。
const FONT_KEYS = new Set(['fontFamily', 'font', 'typeface'])
const HEX_COLOR = /^#[0-9a-f]{6}$/i
const RELATIONSHIP = /<Relationship\b[^>]*?(?:\/>|>[\s\S]*?<\/Relationship>)/g
const SLIDE_TYPE = /\bType\s*=\s*["'][^"']*\/slide["']/

/** 把关系表里“幻灯片”类型的条目挪到最后；没有需要挪的返回 null。 */
function slidesLast(xml: string) {
  const entries = xml.match(RELATIONSHIP) || []
  const slides = entries.filter(entry => SLIDE_TYPE.test(entry))
  const others = entries.filter(entry => !SLIDE_TYPE.test(entry))
  const ordered = [...others, ...slides]

  if (ordered.every((entry, index) => entry === entries[index])) {
    return null
  }

  let index = 0

  return xml.replace(RELATIONSHIP, () => ordered[index++])
}

/**
 * pptx-viewer 0.2.2 按“类型名互相包含”查关系，`.../slideMaster`、`.../slideLayout` 都包含 `slide`。
 * 幻灯片条目排在前面时（WPS 保存的文件常见），会把某一页当成母版或版式叠到每一页上；解析前把这些条目挪到最后。
 */
export function fixRelationshipOrder(bytes: Uint8Array): Uint8Array {
  const rels = unzipSync(bytes, { filter: file => file.name.endsWith('.rels') })
  const fixed = new Map<string, string>()

  for (const [name, data] of Object.entries(rels)) {
    const next = slidesLast(strFromU8(data))

    if (next !== null) {
      fixed.set(name, next)
    }
  }

  if (fixed.size === 0) {
    return bytes
  }

  const files = unzipSync(bytes)

  for (const [name, xml] of fixed) {
    files[name] = strToU8(xml)
  }

  // 只为交给解析器重新打包，不压缩以省时间。
  return zipSync(files, { level: 0 })
}

interface TableModel {
  type: 'table'
  rows: { cells: { text?: { paragraphs: { runs: { fontFamily?: string }[] }[] } }[] }[]
}

/** pptx-viewer 0.2.2 给单元格字体名再套一层双引号写进双引号属性，任何字体名都会截断样式；单元格改用表格默认字体，保住颜色和字号。 */
function dropTableFonts(table: TableModel) {
  for (const row of table.rows) {
    for (const cell of row.cells || []) {
      for (const paragraph of cell.text?.paragraphs || []) {
        for (const run of paragraph.runs || []) {
          delete run.fontFamily
        }
      }
    }
  }
}

/** 递归清理解析结果里会被拼进 HTML 的字段：字体名去掉能闭合引号或属性的字符，颜色只保留六位十六进制。 */
export function cleanPresentation(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value) || ArrayBuffer.isView(value)) {
    return
  }

  seen.add(value)

  if (value instanceof Map) {
    value.forEach(item => cleanPresentation(item, seen))

    return
  }

  const record = value as Record<string, unknown>

  if (record.type === 'table' && Array.isArray(record.rows)) {
    dropTableFonts(record as unknown as TableModel)
  }

  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') {
      if (FONT_KEYS.has(key)) {
        record[key] = item.replace(/["'<>;\\\r\n]/g, '')
      } else if (key === 'hex' && !HEX_COLOR.test(item)) {
        record[key] = '#000000'
      }
    } else {
      cleanPresentation(item, seen)
    }
  }
}

/** 读出幻灯片里引用的本地图片，改为内嵌地址；SVG 作为图片显示时不会加载外部或 blob 地址。 */
async function inlineImage(image: Element) {
  const href = image.getAttribute('href') || ''

  if (!href.startsWith('blob:')) {
    if (!href.startsWith('data:')) {
      image.removeAttribute('href')
    }

    return
  }

  const blob = await (await fetch(href)).blob()

  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

  image.setAttribute('href', data)
}

/** 转换软件不可用时在本机直接解析 pptx，按页给出 SVG 图片，接口与 PDF 分页一致，沿用同一个幻灯片查看器。 */
export async function openPptxPages(bytes: ArrayBuffer): Promise<PdfPages> {
  let presentation: Awaited<ReturnType<typeof loadPresentation>>

  try {
    presentation = await loadPresentation(fixRelationshipOrder(new Uint8Array(bytes)))
  } catch {
    throw { code: 'unavailable' }
  } finally {
    document.getElementById(EMBEDDED_FONT_STYLE)?.remove()
  }

  const { width, height } = presentation.slideSize

  if (!Number.isFinite(width + height) || width <= 0 || height <= 0 || presentation.slides.length === 0) {
    presentation.cleanup()
    throw { code: 'unsupported' }
  }

  cleanPresentation(presentation)

  const scale = LONG_EDGE / Math.max(width, height)
  const size: PdfPageSize = { width, height }
  const pages = presentation.slides.map(() => size)
  const cache = new Map<number, string>()
  const pending = new Map<number, Promise<string>>()
  let closed = false

  /** 画出一页并序列化为独立的 SVG 图片；关闭后不再创建地址。 */
  async function render(number: number) {
    const holder = document.createElement('div')
    renderSlideToElement(presentation, number - 1, holder, {
      width: Math.round(width * scale),
      height: Math.round(height * scale)
    })
    const svg = holder.querySelector('svg')

    if (!svg) {
      throw { code: 'unsupported' }
    }

    // 库给 foreignObject 里的 HTML 手写了 xmlns 属性，序列化时会与自动声明重复，SVG 图片因此整页解析失败。
    svg.querySelectorAll('[xmlns]').forEach(element => element.removeAttribute('xmlns'))
    await Promise.all(Array.from(svg.querySelectorAll('image'), inlineImage))

    if (closed) {
      throw { code: 'unavailable' }
    }

    const url = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' })
    )

    cache.set(number, url)

    if (cache.size > CACHE_PAGES) {
      const oldest = cache.keys().next().value!
      URL.revokeObjectURL(cache.get(oldest)!)
      cache.delete(oldest)
    }

    return url
  }

  return {
    pages,
    /** 只读当前可用地址，随后 renderPage 会更新最近使用顺序。 */
    cachedPage: number => cache.get(number),
    /** 同页并发共用一次任务，命中时更新最近使用顺序。 */
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

      const result = render(number)
      pending.set(number, result)
      void result.then(
        () => pending.delete(number),
        () => pending.delete(number)
      )

      return result
    },
    /** 幂等关闭：撤销已生成的页面地址，并释放解析时创建的图片地址。 */
    async dispose() {
      if (closed) {
        return
      }

      closed = true

      for (const url of cache.values()) {
        URL.revokeObjectURL(url)
      }

      cache.clear()
      presentation.cleanup()
    }
  }
}
