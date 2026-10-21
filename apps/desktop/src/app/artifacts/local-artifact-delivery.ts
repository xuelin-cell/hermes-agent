import { toChatMessages } from '@/lib/chat-messages/hydration'
import { chatMessageText } from '@/lib/chat-messages/parts'
import { isArtifactFilePath, mediaPathFromMarkdownHref } from '@/lib/media'
import { previewTargetFromMarkdownHref } from '@/lib/preview-targets'
import { segmentTranscriptDirectives } from '@/lib/transcript-directives'
import type { SessionInfo, SessionMessage } from '@/types/hermes'

import { type ArtifactRecord, collectArtifactsForSession } from './artifact-utils'

/** REST 的旧会话可能把 tool_calls 保留为 JSON 字符串。 */
function hasToolCalls(value: unknown): boolean {
  if (typeof value === 'string') {
    const serialized = value

    try {
      value = JSON.parse(value)
    } catch {
      return Boolean(serialized.trim())
    }
  }

  return Array.isArray(value) ? value.length > 0 : Boolean(value)
}

/** 交付的相对路径只交给来源会话的原生解析器，不尝试下载外部链接。 */
function deliveredLocalPath(href: string): string | null {
  let target = mediaPathFromMarkdownHref(href) ?? previewTargetFromMarkdownHref(href)

  if (target === null) {
    try {
      // file URL 由原生策略解码；媒体引用则已由聊天解析器解码，不能再解一次。
      target = /^file:/i.test(href) ? href : decodeURIComponent(href)
    } catch {
      return null
    }
  }

  if (!target || /[\r\n]/.test(target) || target.startsWith('#')) {
    return null
  }

  if (isArtifactFilePath(target)) {
    return target
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) {
    return null
  }

  return `./${target}`
}

/** 资料库只读明确交付引用；工具产出、过程说明和代码示例不代表已交付。 */
export function collectDeliveredLocalArtifacts(session: SessionInfo, messages: SessionMessage[]): ArtifactRecord[] {
  const deliveries: SessionMessage[] = []
  const deliveredPaths = new Set<string>()

  for (const message of messages) {
    if (message.role !== 'assistant' || hasToolCalls(message.tool_calls)) {
      continue
    }

    // 与聊天共用历史投影，尊重隐藏消息、display_content 和 Responses final-answer。
    // commentary 是过程说明，不能用作本地产物的交付凭据。
    const text = toChatMessages([{ ...message, display_commentary: [] }])
      .filter(row => row.role === 'assistant')
      .map(chatMessageText)
      .join('\n')
      .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[\t ]*(?=\n|$)|$)/gm, '')

    const targets: string[] = []

    for (const match of text.matchAll(/!?\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))\)/g)) {
      targets.push(match[1] ?? match[2])
    }

    for (const line of text.split('\n')) {
      for (const segment of segmentTranscriptDirectives(line) ?? []) {
        if (segment.kind === 'directive' && segment.directive.name === 'preview' && segment.directive.attrs.file) {
          targets.push(`#media:${encodeURIComponent(segment.directive.attrs.file)}`)
        }
      }
    }

    for (const target of targets) {
      const path = deliveredLocalPath(target)

      if (path) {
        deliveredPaths.add(path)
        // 保留显式交付语义，未知扩展名也可作为文件列出。
        const quote = ['"', "'", '`'].find(value => !path.includes(value)) ?? ''
        deliveries.push({ role: 'assistant', timestamp: message.timestamp, content: `MEDIA:${quote}${path}${quote}` })
      }
    }
  }

  // 元信息复用不扩大收录范围，例如含空格文件名中恰好包含另一个有效文件路径。
  return collectArtifactsForSession(session, deliveries).filter(file => deliveredPaths.has(file.value))
}
