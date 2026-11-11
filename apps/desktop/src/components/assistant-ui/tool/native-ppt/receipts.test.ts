import { expect, it } from 'vitest'

import type { ToolPart } from '@/components/assistant-ui/tool/fallback-model'

import { latestNativePptCalls, nativePptReceipt } from './receipts'

function tool(id: string, status = 'draft', source = 'C:\\task\\a.pptx'): ToolPart {
  return {
    type: 'tool-call',
    toolName: 'TencentPpt',
    toolCallId: id,
    result: {
      ok: true,
      presentation: {
        status,
        source_path: source,
        file_path: status === 'final' ? 'C:/task/deliveries/v/a.pptx' : source,
        purpose: 'deliverable',
        written_pages: 3,
        checked_pages: 3,
        version: 'v'
      }
    }
  }
}

it('late persisted final updates the same source card and survives JSON history restoration', () => {
  const draft = tool('create')
  const final = tool('finalize', 'final', 'C:/task/a.pptx')
  const messages = [{ parts: [draft, { ...final, result: undefined }] }]
  expect(latestNativePptCalls(messages).get('c:/task/a.pptx')).toBe('create')
  messages[0].parts[1] = final
  const restored = JSON.parse(JSON.stringify(messages))
  expect(latestNativePptCalls(restored).get('c:/task/a.pptx')).toBe('finalize')
  expect(nativePptReceipt(restored[0].parts[1])).toMatchObject({ final: true, checked: 3, written: 3 })
  expect(nativePptReceipt({ ...final, interrupted: true })?.final).toBe(false)
})

it('hides empty and internal drafts and gives a new edited working revision its own current state', () => {
  for (const presentation of [{ purpose: 'internal', written_pages: 3 }, { written_pages: 0 }]) {
    const base = tool('hidden')
    const result = base.result as { presentation: object }
    expect(
      nativePptReceipt({ ...base, result: { ok: true, presentation: { ...result.presentation, ...presentation } } })
    ).toBeNull()
  }

  const final = tool('finalize', 'final')
  const edit = tool('edit')
  expect(latestNativePptCalls([{ parts: [final, edit] }]).get('c:/task/a.pptx')).toBe('edit')
  expect(nativePptReceipt(final)?.path).toContain('/deliveries/')
  expect(nativePptReceipt(edit)?.final).toBe(false)
})
