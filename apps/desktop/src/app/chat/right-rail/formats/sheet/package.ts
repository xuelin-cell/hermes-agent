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

/** 样式和图片共用一次解压；只读取工作簿 XML 及内嵌位图，不触碰外部文件。 */
export function openWorkbookPackage(bytes: Uint8Array) {
  let xmlSize = 0,
    mediaSize = 0

  const parts =
    bytes[0] === 80 && bytes[1] === 75
      ? unzipSync(bytes, {
          filter: file => {
            const xml = /^xl\/.*\.(xml|rels)$/.test(file.name)
            const media = /^xl\/media\/.*\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)

            if (xml) {
              xmlSize += file.originalSize
            }

            if (media) {
              mediaSize += file.originalSize
            }

            if (xmlSize > 16 * 1024 * 1024 || mediaSize > 32 * 1024 * 1024) {
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

    const text = strFromU8(parts[name])

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
