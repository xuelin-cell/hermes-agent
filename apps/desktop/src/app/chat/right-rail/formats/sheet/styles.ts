import { parseColor, toHex } from '@hermes/shared/color'
import { strFromU8, unzipSync } from 'fflate'

export interface PreviewStyle {
  fontFamily?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  fill?: string
  horizontal?: string
  vertical?: string
  wrap?: boolean
  borders?: Partial<Record<'l' | 'r' | 't' | 'b', { style: string; color: string }>>
}

// 文档格式规定的默认色板，不是应用界面的主题颜色。
const THEME_KEYS = 'lt1 dk1 lt2 dk2 accent1 accent2 accent3 accent4 accent5 accent6 hlink folHlink'.split(' ')
const DEFAULT_THEME = 'FFFFFF 000000 EEECE1 1F497D 4F81BD C0504D 9BBB59 8064A2 4BACC6 F79646 0000FF 800080'.split(' ')

const INDEXED = (
  '000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF ' +
  '800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF ' +
  '000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 ' +
  '3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333'
).split(' ')

/** 按局部名称读取直接子项，不依赖 XML 的具体前缀。 */
function children(parent: Element | undefined, name: string) {
  return Array.from(parent?.children || []).filter(element => element.localName === name)
}

/** 单项属性块只读取直接子项，避免误把嵌套格式当成本层。 */
function child(parent: Element | undefined, name: string) {
  return children(parent, name)[0]
}

/** 缺失属性保持缺失，避免 Number(null) 把不存在的颜色错误变成色板 0。 */
function attr(element: Element | undefined, name: string) {
  return element?.getAttribute(name) ?? undefined
}

/** 后代查询同样忽略前缀，兼容正常的命名空间序列化差异。 */
function descendants(parent: Element | Document | undefined, name: string) {
  return Array.from(parent?.getElementsByTagNameNS('*', name) || [])
}

/** Excel tint 调整 HSL 的亮度，不能用应用 UI 的 sRGB 混色替代。 */
function tintColor(hex: string, tint: number) {
  const [r, g, b] = parseColor(hex)!.map(value => value / 255)

  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min

  const light = (max + min) / 2
  const saturation = delta ? delta / (1 - Math.abs(2 * light - 1)) : 0
  const hue = !delta ? 0 : max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  const next = tint < 0 ? light * (1 + tint) : light * (1 - tint) + tint
  const chroma = (1 - Math.abs(2 * next - 1)) * saturation

  const x = chroma * (1 - Math.abs((hue % 2) - 1)),
    offset = next - chroma / 2

  const channels = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x]
  ][Math.floor(hue)]

  return toHex(channels.map(value => (value + offset) * 255) as [number, number, number]).toUpperCase()
}

/** 只接受文档中的 RGB、主题或索引色；自动色交给查看器默认处理。 */
function color(element: Element | undefined, theme: string[], indexed: string[]) {
  if (!element || ['1', 'true'].includes(attr(element, 'auto') || '')) {
    return undefined
  }

  const rgb = attr(element, 'rgb')

  const themeId = attr(element, 'theme'),
    index = attr(element, 'indexed')

  const value =
    rgb?.slice(-6) ||
    (themeId !== undefined ? theme[Number(themeId)] : undefined) ||
    (index !== undefined ? indexed[Number(index)] : undefined)

  const tint = Number(attr(element, 'tint') || 0)

  if (!value || !/^[0-9a-f]{6}$/i.test(value) || !Number.isFinite(tint) || Math.abs(tint) > 1) {
    return undefined
  }

  return tintColor(value, tint)
}

/** 字体布尔节点既支持空节点，也尊重显式关闭的 val=0/false。 */
function enabled(parent: Element, name: string) {
  const element = child(parent, name)

  return !!element && !['0', 'false', 'none'].includes(attr(element, 'val') || '')
}

/** 只解压工作簿 XML 与关系；资源超限或坏 XML 走既有失败链，不静默丢掉样式。 */
export function readWorkbookStyles(bytes: Uint8Array): Map<string, Map<string, PreviewStyle>> {
  const result = new Map<string, Map<string, PreviewStyle>>()

  if (bytes[0] !== 80 || bytes[1] !== 75) {
    return result
  }

  let expanded = 0

  const parts = unzipSync(bytes, {
    filter: file => {
      if (!/^xl\/.*\.(xml|rels)$/.test(file.name)) {
        return false
      }

      expanded += file.originalSize

      if (expanded > 16 * 1024 * 1024) {
        throw { code: 'too_large' }
      }

      return true
    }
  })

  /** XML 仅作为数据读取，不加载 DTD、链接或其它外部内容。 */
  function xml(name: string | undefined) {
    if (!name || !parts[name]) {
      return undefined
    }

    const text = strFromU8(parts[name])

    if (/<!DOCTYPE/i.test(text)) {
      throw { code: 'unsupported' }
    }

    const doc = new DOMParser().parseFromString(text, 'application/xml')

    if (doc.getElementsByTagName('parsererror').length) {
      throw { code: 'unsupported' }
    }

    return doc
  }

  const workbook = xml('xl/workbook.xml')

  if (!workbook) {
    return result
  } // ODS 等仍由原有通用解析器负责。

  const rels = descendants(xml('xl/_rels/workbook.xml.rels'), 'Relationship').filter(
    rel => attr(rel, 'TargetMode') !== 'External'
  )

  /** 关系只定位压缩包内部文件，绝不请求 URL 或读取本机路径。 */
  function part(rel: Element | undefined) {
    const target = attr(rel, 'Target')

    if (!target) {
      return undefined
    }

    const url = new URL(target, 'https://package.invalid/xl/workbook.xml')

    return url.origin === 'https://package.invalid' ? decodeURIComponent(url.pathname.slice(1)) : undefined
  }

  const styles = xml(part(rels.find(rel => attr(rel, 'Type')?.endsWith('/styles'))))?.documentElement

  if (!styles) {
    return result
  }

  const theme = xml(part(rels.find(rel => attr(rel, 'Type')?.endsWith('/theme'))))
  const scheme = descendants(theme, 'clrScheme')[0]

  const colors = THEME_KEYS.map((name, index) => {
    const definition = child(scheme, name)?.firstElementChild || undefined

    return attr(definition, 'lastClr') || attr(definition, 'val') || DEFAULT_THEME[index]
  })

  const custom = children(child(child(styles, 'colors'), 'indexedColors'), 'rgbColor')
  const indexed = custom.length ? custom.map(item => attr(item, 'rgb')?.slice(-6) || '') : INDEXED

  const fonts = children(child(styles, 'fonts'), 'font').map((font): PreviewStyle => {
    const group = descendants(theme, attr(child(font, 'scheme'), 'val') === 'major' ? 'majorFont' : 'minorFont')[0]

    const names = [
      attr(child(font, 'name'), 'val'),
      attr(child(group, 'latin'), 'typeface'),
      attr(child(group, 'ea'), 'typeface'),
      ...children(group, 'font')
        .filter(item => ['Hans', 'Hant', 'Jpan', 'Hang'].includes(attr(item, 'script') || ''))
        .map(item => attr(item, 'typeface'))
    ]

    // FortuneSheet 的 ff 是单个字体名，不能传 CSS 字体列表；缺字由组件已有后备字体处理。
    const family = names.find(Boolean)?.replace(/["\\]/g, '')
    const size = Number(attr(child(font, 'sz'), 'val'))

    return {
      fontFamily: family || undefined,
      fontSize: Number.isFinite(size) && size > 0 ? size : undefined,
      bold: enabled(font, 'b'),
      italic: enabled(font, 'i'),
      underline: enabled(font, 'u'),
      strike: enabled(font, 'strike'),
      color: color(child(font, 'color'), colors, indexed)
    }
  })

  const fills = children(child(styles, 'fills'), 'fill').map(fill => {
    const pattern = child(fill, 'patternFill')

    return attr(pattern, 'patternType') === 'solid' ? color(child(pattern, 'fgColor'), colors, indexed) : undefined
  })

  const borders = children(child(styles, 'borders'), 'border').map(border => {
    const sides: PreviewStyle['borders'] = {}

    for (const [name, key] of [
      ['left', 'l'],
      ['right', 'r'],
      ['top', 't'],
      ['bottom', 'b']
    ] as const) {
      const side = child(border, name),
        style = attr(side, 'style')

      if (style && style !== 'none') {
        sides[key] = { style, color: color(child(side, 'color'), colors, indexed) || '#000000' }
      }
    }

    return sides
  })

  const bases = children(child(styles, 'cellStyleXfs'), 'xf')

  const formats = children(child(styles, 'cellXfs'), 'xf').map((xf): PreviewStyle => {
    const base = bases[Number(attr(xf, 'xfId') || 0)]

    /** 显式 apply*=0 使用基础格式，缺失引用继承基础格式，不猜测编号。 */
    function reference(kind: string) {
      const owner = ['0', 'false'].includes(attr(xf, `apply${kind}`) || '') ? base : xf
      const field = `${kind.toLowerCase()}Id`

      return Number(attr(owner, field) ?? attr(base, field) ?? 0)
    }

    const alignment = ['0', 'false'].includes(attr(xf, 'applyAlignment') || '')
      ? child(base, 'alignment')
      : child(xf, 'alignment') || child(base, 'alignment')

    return {
      ...fonts[reference('Font')],
      fill: fills[reference('Fill')],
      borders: borders[reference('Border')],
      horizontal: attr(alignment, 'horizontal'),
      vertical: attr(alignment, 'vertical') || 'bottom',
      wrap: ['1', 'true'].includes(attr(alignment, 'wrapText') || '')
    }
  })

  let count = 0

  for (const sheet of descendants(workbook, 'sheet')) {
    const id = Array.from(sheet.attributes).find(attribute => attribute.localName === 'id')?.value
    const doc = xml(part(rels.find(rel => attr(rel, 'Id') === id)))
    const cells = new Map<string, PreviewStyle>()

    for (const cell of descendants(doc, 'c')) {
      const address = attr(cell, 'r') || ''

      if (!/^[A-Z]+([1-9]\d*)$/.test(address) || Number(address.match(/\d+$/)![0]) > 500) {
        continue
      }

      if (++count > 250000) {
        throw { code: 'too_large' }
      }

      cells.set(address, formats[Number(attr(cell, 's') || 0)] || {})
    }

    result.set(attr(sheet, 'name') || '', cells)
  }

  return result
}
