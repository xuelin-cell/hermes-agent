import { computed, type ReadableAtom } from 'nanostores'

import type { ToolPart } from '@/components/assistant-ui/tool/fallback-model'
import type { ChatMessage } from '@/lib/chat-messages'
import { toolResultRecord } from '@/lib/tool-result-metadata'

export function nativePptReceipt(part: ToolPart) {
  if (part.toolName !== 'TencentPpt') {return null}
  const result = toolResultRecord(part)
  const receipt = result.presentation

  if (!receipt || typeof receipt !== 'object') {return null}
  const r = receipt as Record<string, unknown>
  const written = Number(r.written_pages) || 0

  if (r.purpose === 'internal' || written <= 0 || typeof r.file_path !== 'string' || typeof r.source_path !== 'string')
    {return null}

  if (r.status !== 'draft' && r.status !== 'final') {return null}

  return {
    source: r.source_path.replaceAll('\\', '/').toLowerCase(),
    path: r.file_path,
    final: r.status === 'final' && result.ok === true && !part.isError && !part.interrupted,
    written,
    checked: (Number(r.checked_pages) || 0) + (Number(r.structural_checked_pages) || 0),
    pendingVisual: Array.isArray(r.visual_pending_pages) ? r.visual_pending_pages.length : 0,
    visualIssues: r.visual_issues && typeof r.visual_issues === 'object'
      ? Object.values(r.visual_issues).filter((value): value is string => typeof value === 'string') : []
  }
}

export function latestNativePptCalls(messages: { parts: readonly { type: string }[] }[]) {
  const latest = new Map<string, string | undefined>()

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool-call') {continue}
      const tool = part as ToolPart
      const receipt = nativePptReceipt(tool)

      if (receipt) {latest.set(receipt.source, tool.toolCallId)}
    }
  }

  return latest
}


const receiptStores = new WeakMap<ReadableAtom<ChatMessage[]>, ReadableAtom<Map<string, string | undefined>>>()

export function nativePptCallsStore(messages: ReadableAtom<ChatMessage[]>) {
  let store = receiptStores.get(messages)

  if (!store) {
    store = computed(messages, latestNativePptCalls)
    receiptStores.set(messages, store)
  }

  return store
}
