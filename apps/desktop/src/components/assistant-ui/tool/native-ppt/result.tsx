import { useStore } from '@nanostores/react'

import { useSessionView } from '@/app/chat/session-view'
import type { ToolPart } from '@/components/assistant-ui/tool/fallback-model'

import { nativePptCallsStore, nativePptReceipt } from './receipts'

export function NativePptResult({ part }: { part: ToolPart }) {
  const latest = useStore(nativePptCallsStore(useSessionView().$messages))
  const receipt = nativePptReceipt(part)

  if (!receipt) {return null}

  if (latest.has(receipt.source) && latest.get(receipt.source) !== part.toolCallId) {return null}

  return (
    <div className="grid gap-1 px-2 py-1.5 text-xs text-(--ui-text-secondary)">
      <p>
        {receipt.final ? '最终稿' : '制作中 · 草稿'} · 已写入 {receipt.written} 页 · 已检查 {receipt.checked} 页
      </p>
      {receipt.pendingVisual > 0 && <p>有 {receipt.pendingVisual} 页尚未完成视觉核对</p>}
      {receipt.visualIssues.map((issue, index) => <p key={index}>待修问题：{issue}</p>)}
    </div>
  )
}
