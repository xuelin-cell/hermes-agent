import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { parseMarkdownIntoBlocksCached } from '@/lib/markdown-blocks'
import { isFileMediaPath, mediaPathFromMarkdownHref } from '@/lib/media'
import { cleanPath, comparisonPath } from '@/lib/path-compare'
import { previewTargetFromMarkdownHref } from '@/lib/preview-targets'

const parser = unified().use(remarkParse)
const filteredBlocks = new WeakMap<string[], string[]>()

interface DeliveryNode {
  alt?: string | null
  children?: DeliveryNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
  type: string
  url?: string
  value?: string
}

/** 只统一可确认的路径写法；不访问文件系统，也不猜测相对路径、联接或远端盘符。 */
export function deliveryPathIdentity(value: string): { key: string; scratch: boolean } | null {
  let path = value.trim().replace(/^([`"'])(.*)\1$/, '$2')

  if (/^(?:https?|data|blob):/i.test(path)) {
    return null
  }

  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path)

      if (url.hostname && url.hostname !== 'localhost') {
        return null
      }

      path = decodeURIComponent(url.pathname)
    } catch {
      return null
    }
  }

  const windows = /^\/?[a-z]:[/\\]/i.test(path)

  if (windows) {
    path = comparisonPath(cleanPath(path.replace(/^\//, '')))
  }

  return { key: path, scratch: path.split(windows ? '/' : /[/\\]/).includes('.tmp') }
}

/** 从现有卡片入口取路径，普通网页链接和页面锚点保持原样。 */
function deliveryTarget(href: string): string | null {
  return mediaPathFromMarkdownHref(href) ?? previewTargetFromMarkdownHref(href) ?? (isFileMediaPath(href) ? href : null)
}

/** 提取重复引用的可读标签，保留说明但不再次生成链接或媒体。 */
function nodeLabel(node: DeliveryNode): string {
  return node.value ?? node.alt ?? (node.children ?? []).map(nodeLabel).join('')
}

/** 复用已有分块缓存；只解析含文件入口的块，同一文本各块共用本次局部去重集合。 */
export function parseDeliveryBlocks(text: string): string[] {
  const blocks = parseMarkdownIntoBlocksCached(text)
  const cached = filteredBlocks.get(blocks)

  if (cached) {
    return cached
  }

  const seen = new Set<string>()
  const result = blocks.map(block => filterDeliveryBlock(block, seen))
  const selected = result.every((block, index) => block === blocks[index]) ? blocks : result
  filteredBlocks.set(blocks, selected)

  return selected
}

/** 仅处理实际文件链接，代码示例和普通网页段落不增加 Markdown 解析。 */
function filterDeliveryBlock(text: string, seen: Set<string>): string {
  if (!/(?:#media:|#preview[:/]|file:|\]\(<?(?:\/|~\/|[a-z]:[\\/]))/i.test(text) || /^\s*(?:`{3,}|~{3,})/.test(text)) {
    return text
  }

  const edits: { start: number; end: number; replacement: string }[] = []
  const pending: DeliveryNode[] = [parser.parse(text)]

  while (pending.length) {
    const node = pending.pop()!

    if ((node.type === 'link' || node.type === 'image') && node.url) {
      const target = deliveryTarget(node.url)
      const identity = target === null ? null : deliveryPathIdentity(target)
      const start = node.position?.start.offset
      const end = node.position?.end.offset

      if (identity && start !== undefined && end !== undefined) {
        if (identity.scratch || seen.has(identity.key)) {
          const replacement = nodeLabel(node).replace(/[\\`*_{}[\]<>!|]/g, '\\$&')
          edits.push({ start, end, replacement })
        } else {
          seen.add(identity.key)
        }

        continue
      }
    }

    if (node.children) {
      pending.push(...node.children.toReversed())
    }
  }

  for (const edit of edits.toReversed()) {
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end)
  }

  return text
}
