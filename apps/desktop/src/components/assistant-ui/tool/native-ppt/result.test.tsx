import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { MessageTextContent } from '@/components/assistant-ui/markdown-text'
import type { ToolPart } from '@/components/assistant-ui/tool/fallback-model'

import { NativePptResult } from './result'

afterEach(cleanup)

it('keeps the PPT status while offering the delivered file only in the final answer', async () => {
  const file = 'C:/task/deliveries/version/report.pptx'

  const part: ToolPart = {
    type: 'tool-call', toolName: 'TencentPpt', toolCallId: 'finalize',
    result: { ok: true, presentation: {
      status: 'final', purpose: 'deliverable', source_path: 'C:/task/report.pptx',
      file_path: file, written_pages: 4, checked_pages: 4
    } }
  }

  render(<>
    <NativePptResult part={part} />
    <MessageTextContent text={`制作完成。\n\nMEDIA:${file}`} />
  </>)

  expect(screen.getByText(/已写入 4 页 · 已检查 4 页/)).toBeTruthy()
  expect(await screen.findAllByText('report.pptx')).toHaveLength(1)
})
