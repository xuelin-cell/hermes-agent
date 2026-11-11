import type { ModelOptionsResult } from '@hermes/shared'
import { expect, it } from 'vitest'

import { pptDefaultModel } from './ppt-model-choice'

const options = {
  providers: [{ slug: 'custom:office', models: ['deepseek-v4-flash', 'deepseek-v4.1-flash'] }]
} as ModelOptionsResult

it('chooses an available V4.1 only for a PPT default', () => {
  expect(pptDefaultModel('制作三页周报PPT', false, options)).toEqual({
    provider: 'custom:office',
    model: 'deepseek-v4.1-flash',
    reasoning_effort: 'high'
  })
  expect(pptDefaultModel('制作PPT', false, options, 'medium')?.reasoning_effort).toBe('high')
  expect(pptDefaultModel('制作PPT', false, options, 'low')?.reasoning_effort).toBe('low')
  expect(pptDefaultModel('制作三页周报PPT', true, options)).toBeNull()
  expect(pptDefaultModel('写一封邮件', false, options)).toBeNull()
  expect(pptDefaultModel('制作PPT', false, { providers: [] } as unknown as ModelOptionsResult)).toBeNull()
})
