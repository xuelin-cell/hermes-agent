import { deliveryPathIdentity } from '@/lib/delivery-cards'
import { mediaDisplayLabel, mediaMarkdownHref } from '@/lib/media'

import type { ChatMessage, ChatMessagePart } from './types'

export function textPart(text: string, timestamp?: number): ChatMessagePart {
  return { type: 'text', text, ...(timestamp !== undefined ? { timestamp } : {}) }
}

export function reasoningPart(text: string, timestamp?: number): ChatMessagePart {
  return { type: 'reasoning', text, ...(timestamp !== undefined ? { timestamp } : {}) }
}

/**
 * Known deliverable file extensions — mirrors the Python-side
 * `MEDIA_DELIVERY_EXTS` in `gateway/platforms/base.py` so the two surfaces
 * agree on which `MEDIA:` paths are valid. Used to anchor the end of an
 * unquoted path that may contain interior spaces (#96657).
 */
const MEDIA_DELIVERY_EXTS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'tiff',
  'svg',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'webm',
  '3gp',
  'mp3',
  'm2a',
  'wav',
  'ogg',
  'opus',
  'm4a',
  'flac',
  'pdf',
  'docx',
  'doc',
  'odt',
  'rtf',
  'txt',
  'md',
  'epub',
  'xlsx',
  'xls',
  'ods',
  'csv',
  'tsv',
  'json',
  'xml',
  'yaml',
  'yml',
  'kmz',
  'kml',
  'geojson',
  'gpx',
  'pptx',
  'ppt',
  'odp',
  'key',
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'apk',
  'ipa',
  'html',
  'htm'
] as const

// Sort longest-first so the alternation never matches a shorter ext as a
// prefix of a longer one (e.g. `tar` before a hypothetical `tar.gz`).
const _MEDIA_EXT_ALTERNATION = [...MEDIA_DELIVERY_EXTS].sort((a, b) => b.length - a.length).join('|')

/**
 * Unquoted path branch: starts with a path anchor (`~/`, `/`, `X:\` or `X:/`),
 * allows interior whitespace, and anchors the end on a known deliverable
 * extension. Matches the Python-side `MEDIA_TAG_CLEANUP_RE` behavior where
 * `(?:[^\S\n]+\S+?)*?\.(?:EXT)` permits spaces inside filenames (#96657).
 */
// 未加引号的交付路径在扩展名后的中文标点处结束，后面的说明仍属于正文。
const _MEDIA_PATH_END = '(?=[\\s`"\'*_,;:)\\]}，。；：！？、」』）】]|MEDIA:|$)'
// 路径可以含空格，但空格后紧跟 MEDIA: 是下一个文件，不能并进同一路径。
const _MEDIA_PATH_ANCHORED = `(?:~/|/|[A-Za-z]:[/\\\\])\\S+?(?:[^\\S\\n]+(?!MEDIA:)\\S+?)*?\\.(?:${_MEDIA_EXT_ALTERNATION})${_MEDIA_PATH_END}`
const _MEDIA_PATH_RELATIVE = `[^\\s\`"]+?\\.(?:${_MEDIA_EXT_ALTERNATION})${_MEDIA_PATH_END}`

// Bare-word fallback for paths the anchored branch misses (relative paths,
// unknown extensions). Stop before backtick and double-quote so an inline-code
// closer is not swallowed. Apostrophes stay legal inside the path.
// 已识别出扩展名边界时，不允许整行匹配回退后再次吞入后面的说明。
const _MEDIA_PATH_BARE = `(?!${_MEDIA_PATH_ANCHORED}|${_MEDIA_PATH_RELATIVE})[^\\s\`"]+`

const MEDIA_LINE_RE = new RegExp(
  `(^|\\n)[\\t ]*[\`"']?MEDIA:\\s*(?<line>\`[^\`\\n]+\`|"[^"\\n]+"|'[^'\\n]+'|${_MEDIA_PATH_ANCHORED}|${_MEDIA_PATH_RELATIVE}|${_MEDIA_PATH_BARE})[\`"']?[\\t ]*(\\n|$)`,
  'g'
)

const MEDIA_TAG_RE = new RegExp(
  `[\`"']?MEDIA:\\s*(?<inline>\`[^\`\\n]+\`|"[^"\\n]+"|'[^'\\n]+'|${_MEDIA_PATH_ANCHORED}|${_MEDIA_PATH_RELATIVE}|${_MEDIA_PATH_BARE})[\`"']?`,
  'g'
)

const MEDIA_TOKEN_RE = new RegExp(`${MEDIA_LINE_RE.source}|${MEDIA_TAG_RE.source}`, 'g')

// 模型会省略带空格目标所需的尖括号，不能直接交给标准 Markdown 链接解析器。
const MEDIA_MARKDOWN_START_RE = /!?\[[^\]\n]*\]\([\t ]*(<?)MEDIA:[\t ]*/g

function unquoteMediaPath(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed[0]

  if (quote && quote === trimmed.at(-1) && ['"', "'", '`'].includes(quote)) {
    return trimmed.slice(1, -1)
  }

  // A trailing backtick or double-quote left in the value is formatting residue,
  // not part of the path. Apostrophes are not residue (`john's.md`).
  const last = trimmed.at(-1)

  return last === '`' || last === '"' ? trimmed.slice(0, -1) : trimmed
}

function mediaLink(value: string): string {
  const path = unquoteMediaPath(value)

  return `[${mediaDisplayLabel(path)}](${mediaMarkdownHref(path)})`
}

/** 按成对括号找目标结尾；引号和尖括号内的括号属于文件名。 */
function mediaMarkdownEnd(text: string, start: number, angled: boolean): number {
  let depth = 1
  const quote = ['"', "'", '`'].includes(text[start]) ? text[start] : ''
  let quoted = Boolean(quote)

  for (let index = start; index < text.length && !/[\r\n]/.test(text[index]); index++) {
    const char = text[index]

    if (angled) {
      if (char === '>') {
        const close = /^[\t ]*\)/.exec(text.slice(index + 1))

        return close ? index + close[0].length : -1
      }
    } else if (quoted) {
      if (index > start && char === quote) {
        quoted = false
      }
    } else if (char === '(') {
      depth++
    } else if (char === ')' && --depth === 0) {
      return index
    }
  }

  return -1
}

// 私用区字符包住序号，作为 Markdown 包装的占位符；不含空白，不会被路径规则当作行首或行尾。
const MEDIA_WRAPPED_RE = new RegExp(`\\uE000(\\d+)\\uE001|${MEDIA_TOKEN_RE.source}`, 'g')

/** 聊天渲染和产物收集共用包装与裸标记处理，保持顺序且每个标记只消费一次。 */
function replaceMediaTags(text: string, replace: (value: string) => string): string {
  let cursor = 0
  let masked = ''
  const wrapped: string[] = []

  for (const match of text.matchAll(MEDIA_MARKDOWN_START_RE)) {
    if (match.index < cursor) {
      continue
    }

    const start = match.index + match[0].length
    const end = mediaMarkdownEnd(text, start, Boolean(match[1]))

    if (end < 0) {
      continue
    }

    wrapped.push(text.slice(start, end).replace(match[1] ? />[\t ]*$/ : /[\t ]*$/, ''))
    masked += `${text.slice(cursor, match.index)}${wrapped.length - 1}`
    cursor = end + 1
  }

  // 包装先换成占位符再整段识别：裸标记仍按原文判断行首行尾，替换顺序与原文一致。
  return (masked + text.slice(cursor)).replace(
    MEDIA_WRAPPED_RE,
    (match, index: string | undefined, lead: string, value: string | undefined, trailer: string, inline: string) => {
      if (index !== undefined) {
        const target = wrapped[Number(index)]

        return target === undefined ? match : replace(target)
      }

      return value === undefined ? replace(inline) : `${lead}${replace(value)}${trailer}`
    }
  )
}

/** 将同一解析结果转为聊天媒体卡片链接。 */
export function renderMediaTags(text: string): string {
  return replaceMediaTags(text, mediaLink)
}

/** Raw `MEDIA:` values in `text`, quotes intact — the one parser Artifacts and chat share. */
export function mediaTagValues(text: string): string[] {
  const values: string[] = []
  const seen = new Set<string>()
  replaceMediaTags(text, value => {
    const identity = deliveryPathIdentity(unquoteMediaPath(value))

    if (!identity?.scratch && !seen.has(identity?.key ?? value)) {
      seen.add(identity?.key ?? value)
      values.push(value)
    }

    return ''
  })

  return values
}

export function assistantTextPart(text: string, timestamp?: number): ChatMessagePart {
  return textPart(renderMediaTags(text), timestamp)
}

export function chatMessageText(message: ChatMessage): string {
  return message.parts
    .filter((part): part is Extract<ChatMessagePart, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('')
}

export interface UnspokenTurnSpeech {
  /** First unspoken assistant bubble — stable for the turn, the live speech session binds to it. */
  id: string
  /** Whether the newest assistant bubble is still streaming. */
  pending: boolean
  /** All unspoken assistant text in message order, bubbles joined on a blank line. */
  text: string
}

/**
 * Collect every unspoken assistant bubble after `lastSpokenId`, in order.
 *
 * A turn with tool calls produces several assistant bubbles — narration
 * ("Let me check…") sealed as interims, then the final answer as a fresh
 * bubble. Voice conversation speaks a turn through ONE live session bound to
 * one response id, so it needs all of that text as a single growing string;
 * selecting only one bubble silently drops everything after it. The blank-line
 * join is a sentence boundary for the server's cutter, so a sealed bubble's
 * tail is flushed as soon as the next bubble starts.
 *
 * If `lastSpokenId` is missing or stale (session id assigned mid-turn,
 * live-tail rewrite missed), do **not** fall back to index -1 — that replays
 * every earlier assistant turn as one speech string. Bound to the current
 * turn (assistant bubbles after the last user message) instead. Hidden user
 * rows count: a widget intent (`display_kind: hidden`) is a real turn for the
 * agent even though no bubble renders. A slice with no user row (mid-turn
 * interims only) still collects those assistants.
 */
export function collectUnspokenTurnSpeech(
  messages: ChatMessage[],
  lastSpokenId: string | null
): UnspokenTurnSpeech | null {
  let spokenIndex = lastSpokenId ? messages.findLastIndex(m => m.id === lastSpokenId) : -1

  if (spokenIndex < 0) {
    const lastUser = messages.findLastIndex(m => m.role === 'user')

    if (lastUser >= 0) {
      spokenIndex = lastUser
    }
  }

  let id: string | null = null
  let pending = false
  const parts: string[] = []

  for (const message of messages.slice(spokenIndex + 1)) {
    if (message.role !== 'assistant' || message.hidden) {
      continue
    }

    pending = Boolean(message.pending)
    const text = chatMessageText(message).trim()

    if (!text) {
      continue
    }

    id ??= message.id
    parts.push(text)
  }

  if (!id) {
    return null
  }

  return { id, pending, text: parts.join('\n\n') }
}

export const normalizeWs = (value: string) => value.replace(/\s+/g, ' ').trim()

type TextPart = Extract<ChatMessagePart, { type: 'text' }>
const isTextPart = (part: ChatMessagePart): part is TextPart => part.type === 'text'

/** The same physical row delivered twice is one occurrence; keep its last copy. */
function dedupeRepeatedRowText(parts: ChatMessagePart[]): ChatMessagePart[] {
  const occurrence = (part: TextPart) => `${part.sourceRowId}:${normalizeWs(part.text)}`
  const lastByOccurrence = new Map<string, number>()

  parts.forEach((part, index) => {
    if (part.type === 'text' && part.sourceRowId !== undefined) {
      lastByOccurrence.set(occurrence(part), index)
    }
  })

  const kept = parts.filter(
    (part, index) =>
      part.type !== 'text' || part.sourceRowId === undefined || lastByOccurrence.get(occurrence(part)) === index
  )

  return kept.length === parts.length ? parts : kept
}

/**
 * Collapse duplicate deliveries of the same text without touching authored
 * repeats. Providers that continue a turn after a tool call sometimes re-send
 * the previous assistant text verbatim as the stop row (tool_calls row, then a
 * stop row with identical prose) — the turn merge then holds the same
 * paragraph twice and everything in it renders twice, most visibly ::preview
 * frames. Only that shape folds across rows: the bubble's final text (no tool
 * call after it) equal to the text directly before it across a tool call.
 * Equal commentary in earlier tool rounds is authored twice and must hydrate
 * in step with the live stream.
 */
export function dedupeRepeatedTextInParts(parts: ChatMessagePart[]): ChatMessagePart[] {
  const rowDeduped = dedupeRepeatedRowText(parts)
  const texts = rowDeduped.flatMap((part, index) => (isTextPart(part) ? [{ index, part }] : []))
  const [previous, last] = texts.slice(-2)

  if (!last || !previous || rowDeduped.slice(last.index + 1).some(part => part.type === 'tool-call')) {
    return rowDeduped
  }

  const key = normalizeWs(last.part.text)

  if (
    !key ||
    key !== normalizeWs(previous.part.text) ||
    !rowDeduped.slice(previous.index + 1, last.index).some(part => part.type === 'tool-call')
  ) {
    return rowDeduped
  }

  return rowDeduped.filter((_, index) => index !== previous.index)
}

/**
 * Merge the final assistant text into a message's parts.
 *
 * - Preserves earlier tool-delimited responses: a missed interim frame must
 *   not make their public text disposable.
 * - Replaces provisional text only in the latest response with its authoritative
 *   final text, retaining confirmed text/reasoning boundaries.
 * - Keeps `reasoning` parts, but drops one that the final text fully covers
 *   (reasoning ⊆ final) — the final restates it. A short final ("Done.") must
 *   NOT swallow a longer reasoning block that merely starts with it (#61447).
 * - Keeps all other part types (tool-call, image, etc.).
 * - Appends the final text as a new text part.
 */
export function mergeFinalAssistantText(
  parts: ChatMessagePart[],
  finalText: string,
  fallbackTimestamp?: number
): ChatMessagePart[] {
  // Empty / whitespace-only completion is not authoritative — keep streamed
  // text, reasoning, and tool parts (#95514).
  if (!finalText.trim()) {
    return parts
  }

  const dedupeReference = normalizeWs(finalText)

  const streamedText = normalizeWs(
    parts
      .filter((part): part is Extract<ChatMessagePart, { type: 'text' }> => part.type === 'text')
      .map(part => part.text)
      .join('')
  )

  // An authoritative final that is exactly the concatenation of streamed text
  // confirms the content without erasing text↔reasoning activity boundaries.
  if (streamedText && streamedText === dedupeReference) {
    return parts
  }

  // A tool call is an explicit model-response boundary even when no
  // message.interim frame sealed the earlier text into a separate bubble.
  // Only the suffix after the last call belongs to this authoritative final.
  const lastToolIndex = parts.findLastIndex(part => part.type === 'tool-call')

  if (lastToolIndex >= 0) {
    const earlier = parts.slice(0, lastToolIndex + 1)

    const earlierText = earlier
      .filter((part): part is Extract<ChatMessagePart, { type: 'text' }> => part.type === 'text')
      .map(part => part.text)
      .join('')

    // Some terminal frames carry cumulative text. Strip only an exact prefix;
    // fuzzy similarity is not proof that two assistant messages are the same.
    const responseText =
      earlierText && finalText.startsWith(earlierText) ? finalText.slice(earlierText.length) : finalText

    const suffix = parts.slice(lastToolIndex + 1)

    // A cumulative final can stop exactly at the pre-tool update. The suffix
    // draft is still provisional; the ordinary empty-final path keeps drafts.
    if (earlierText && finalText === earlierText) {
      return [...earlier, ...suffix.filter(part => part.type !== 'text')]
    }

    return [...earlier, ...mergeFinalAssistantText(suffix, responseText, fallbackTimestamp)]
  }

  const previousText = parts.findLast(part => part.type === 'text')

  const kept = parts.filter(part => {
    if (part.type === 'text') {
      // The tool-delimited prefix was retained above. This suffix is
      // provisional text from the response being finalized.
      return false
    }

    if (part.type !== 'reasoning' || !dedupeReference) {
      return true
    }

    // Reasoning is a restatement only when the final FULLY covers it.
    // The reverse direction is not considered — a short final must not
    // swallow a longer reasoning block (#61447).
    const r = normalizeWs(part.text)

    return !(r && dedupeReference.startsWith(r))
  })

  if (!finalText) {
    return kept
  }

  const finalPart = assistantTextPart(finalText, previousText?.timestamp ?? fallbackTimestamp)

  if (previousText?.completedAt !== undefined) {
    finalPart.completedAt = previousText.completedAt
  }

  return [...kept, finalPart]
}

/** Seal every still-open visible activity when the assistant turn stops. */
export function completeOpenTimelineParts(parts: ChatMessagePart[], completedAt: number): ChatMessagePart[] {
  return parts.map(part =>
    part.timestamp !== undefined && part.completedAt === undefined
      ? ({ ...part, completedAt } as ChatMessagePart)
      : part
  )
}

// Coalesce only adjacent deltas of the same channel. Switching between text
// and reasoning is a real timeline boundary and must remain visible even when
// both channels arrive inside one batched renderer flush.
function appendStreamPart(
  parts: ChatMessagePart[],
  type: 'reasoning' | 'text',
  delta: string,
  timestamp?: number
): { index: number; parts: ChatMessagePart[] } {
  const next = [...parts]

  const tailIndex = next.length - 1
  const tail = next[tailIndex]

  if (tail?.type === type && tail.completedAt === undefined) {
    next[tailIndex] = { ...tail, text: `${tail.text}${delta}` } as ChatMessagePart

    return { index: tailIndex, parts: next }
  }

  if (
    timestamp !== undefined &&
    (tail?.type === 'text' || tail?.type === 'reasoning') &&
    tail.completedAt === undefined
  ) {
    next[tailIndex] = { ...tail, completedAt: timestamp } as ChatMessagePart
  }

  const STREAM_PART: Record<'reasoning' | 'text', (text: string, timestamp?: number) => ChatMessagePart> = {
    reasoning: reasoningPart,
    text: textPart
  }

  next.push(STREAM_PART[type](delta, timestamp))

  return { index: next.length - 1, parts: next }
}

export function appendReasoningPart(parts: ChatMessagePart[], delta: string, timestamp?: number): ChatMessagePart[] {
  return appendStreamPart(parts, 'reasoning', delta, timestamp).parts
}

export function appendAssistantTextPart(
  parts: ChatMessagePart[],
  delta: string,
  timestamp?: number
): ChatMessagePart[] {
  const { index, parts: next } = appendStreamPart(parts, 'text', delta, timestamp)
  const part = next[index]

  if (part?.type !== 'text') {
    return next
  }

  // Re-render from the raw stream, never from the previous render: an unquoted
  // spaced path (`MEDIA:/tmp/AI Brain/report.pdf`) split across deltas would
  // otherwise settle on a card for `/tmp/AI` and keep the rest as prose (#96657).
  const previous = parts[index]
  const source = `${previous?.type === 'text' ? (previous.mediaSource ?? previous.text) : ''}${delta}`

  if (!source.includes('MEDIA:')) {
    return next
  }

  const rendered = renderMediaTags(source)

  next[index] = rendered === source ? { ...part, text: source } : { ...part, mediaSource: source, text: rendered }

  return next
}

/** True when a visible user message follows `messageId` — the reader has moved
 *  on, so a question card at `messageId` counts as answered. */
export function answeredAfter(messages: ChatMessage[], messageId: string): boolean {
  const at = messages.findIndex(message => message.id === messageId)

  return at !== -1 && messages.slice(at + 1).some(message => message.role === 'user' && !message.hidden)
}
