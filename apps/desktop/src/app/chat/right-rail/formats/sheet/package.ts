import { strFromU8, unzipSync } from 'fflate'

/** 按局部名称读取直接子项，不依赖 XML 前缀。 */
export function children(parent: Element | undefined, name: string) {
  return Array.from(parent?.children || []).filter(element => element.localName === name)
}

/** 单项格式只取直接子项，避免混入嵌套内容。 */
export function child(parent: Element | undefined, name: string) {
  return children(parent, name)[0]
}

/** 缺失属性不变成空字符串或数字零。 */
export function attr(element: Element | undefined, name: string) {
  return element?.getAttribute(name) ?? undefined
}

/** 后代查询忽略命名空间前缀。 */
export function descendants(parent: Element | Document | undefined, name: string) {
  return Array.from(parent?.getElementsByTagNameNS('*', name) || [])
}

export const MAX_ROWS = 500

const WORKSHEET = /^xl\/worksheets\/[^/]+\.xml$/

/** 工作表只留前 MAX_ROWS 行和 sheetData 之后的部分（绘图、合并等），看不到的行不建 DOM。 */
function worksheetHead(text: string) {
  const rows = /<(?:[\w.-]+:)?row\b([^>]*)>/g
  let row = 0

  for (let match = rows.exec(text); match; match = rows.exec(text)) {
    // r 属性可以省略，省略时行号顺延。
    row = Number(/\sr="(\d+)"/.exec(match[1])?.[1] ?? row + 1)

    if (row > MAX_ROWS) {
      const close = /<\/(?:[\w.-]+:)?sheetData>/g
      close.lastIndex = match.index
      const end = close.exec(text)

      return end ? text.slice(0, match.index) + text.slice(end.index) : text
    }
  }

  return text
}

/** 样式和图片共用一次解压；只读取工作簿 XML 及内嵌位图，不触碰外部文件。 */
export function openWorkbookPackage(bytes: Uint8Array) {
  let xmlSize = 0,
    sheetSize = 0,
    mediaSize = 0

  const parts =
    bytes[0] === 80 && bytes[1] === 75
      ? unzipSync(bytes, {
          filter: file => {
            const xml = /^xl\/.*\.(xml|rels)$/.test(file.name)
            const media = /^xl\/media\/.*\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)

            // 工作表正文随行数增长，只解析前 500 行，单独计量，不挤占样式、绘图等部件的额度。
            if (xml && WORKSHEET.test(file.name)) {
              sheetSize += file.originalSize
            } else if (xml) {
              xmlSize += file.originalSize
            }

            if (media) {
              mediaSize += file.originalSize
            }

            if (xmlSize > 16 * 1024 * 1024 || sheetSize > 64 * 1024 * 1024 || mediaSize > 32 * 1024 * 1024) {
              throw { code: 'too_large' }
            }

            return xml || media
          }
        })
      : {}

  const documents = new Map<string, Document>()

  /** XML 只作为数据，禁止 DTD；同一部件在样式和绘图间复用解析结果。 */
  function xml(name: string | undefined) {
    if (!name || !parts[name]) {
      return undefined
    }

    if (documents.has(name)) {
      return documents.get(name)
    }

    const text = WORKSHEET.test(name) ? worksheetHead(strFromU8(parts[name])) : strFromU8(parts[name])

    if (/<!DOCTYPE/i.test(text)) {
      throw { code: 'unsupported' }
    }

    const doc = new DOMParser().parseFromString(text, 'application/xml')

    if (doc.getElementsByTagName('parsererror').length) {
      throw { code: 'unsupported' }
    }

    documents.set(name, doc)

    return doc
  }

  /** 关系只定位 ZIP 内部；外链、URL 和越出工作簿目录的目标均不采纳。 */
  function relationships(owner: string) {
    const slash = owner.lastIndexOf('/')
    const path = `${owner.slice(0, slash + 1)}_rels/${owner.slice(slash + 1)}.rels`

    return descendants(xml(path), 'Relationship').flatMap(rel => {
      if (attr(rel, 'TargetMode') === 'External' || !attr(rel, 'Target')) {
        return []
      }

      const url = new URL(attr(rel, 'Target')!, `https://package.invalid/${owner}`)
      const target = decodeURIComponent(url.pathname.slice(1))

      return url.origin === 'https://package.invalid' && target.startsWith('xl/') && !target.includes('\\')
        ? [{ id: attr(rel, 'Id'), type: attr(rel, 'Type'), target }]
        : []
    })
  }

  return { parts, xml, relationships }
}

export type WorkbookPackage = ReturnType<typeof openWorkbookPackage>

/** 图片和图表共用真实绘图关系，不重复遍历工作簿或猜测部件编号。 */
export function* workbookDrawings(archive: WorkbookPackage) {
  const rels = archive.relationships('xl/workbook.xml')

  for (const sheet of descendants(archive.xml('xl/workbook.xml'), 'sheet')) {
    const id = Array.from(sheet.attributes).find(attribute => attribute.localName === 'id')?.value
    const sheetPart = rels.find(rel => rel.id === id)?.target

    if (!sheetPart) {
      continue
    }

    const drawing = descendants(archive.xml(sheetPart), 'drawing')[0]

    if (!drawing) {
      continue
    }

    const drawingId = Array.from(drawing.attributes).find(attribute => attribute.localName === 'id')?.value
    const drawingPart = archive.relationships(sheetPart).find(rel => rel.id === drawingId)?.target
    const doc = archive.xml(drawingPart)

    if (!doc || !drawingPart) {
      throw { code: 'unsupported' }
    }

    const relations = archive.relationships(drawingPart)

    for (const anchor of Array.from(doc.documentElement.children)) {
      if (['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'].includes(anchor.localName)) {
        yield { name: attr(sheet, 'name') || '', anchor, relations }
      }
    }
  }
}
