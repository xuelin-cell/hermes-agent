import { expect, it } from 'vitest'

import { skillActivityTitle } from '@/components/assistant-ui/tool/skill-activity'

import { upsertToolPart } from './tool-parts'
import { markToolExecutionFinished } from './tool-execution-progress'
import type { ChatMessage } from './types'

it('shows a returned skill as waiting without inventing a result, and retains the final failure', () => {
  const start = { name: 'skill_view', tool_id: 'skill', args: { name: 'slides' } }
  const messages: ChatMessage[] = [
    {
      id: 'assistant',
      role: 'assistant',
      pending: true,
      parts: upsertToolPart(
        upsertToolPart([], start, 'running', 1),
        {
          name: 'web_search',
          tool_id: 'search',
          args: { query: 'slides' }
        },
        'running',
        1
      )
    }
  ]
  const updated = markToolExecutionFinished(messages, 'skill', 1.2)
  const skill = updated[0].parts[0]
  if (skill.type !== 'tool-call') throw new Error('Expected tool call')
  expect(skillActivityTitle(skill)).toContain('waiting for other tools')
  expect(skill.result).toBeUndefined()
  expect(skill.completedAt).toBeUndefined()
  expect(updated[0].pending).toBe(true)
  expect(updated[0].parts[1]).toBe(messages[0].parts[1])
  expect(markToolExecutionFinished(updated, 'skill', 2)).toBe(updated)
  expect(markToolExecutionFinished(updated, 'missing', 2)).toBe(updated)

  const completed = upsertToolPart(updated[0].parts, { ...start, result: { error: 'not found' } }, 'complete', 33)
  expect(skillActivityTitle(completed[0] as typeof skill)).toContain('Failed to load skill')
  expect(completed[0].completedAt).toBe(33)
  const final = [{ ...updated[0], parts: completed }]
  expect(markToolExecutionFinished(final, 'skill', 34)).toBe(final)
})
