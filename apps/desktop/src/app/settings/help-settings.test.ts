import { expect, it } from 'vitest'
import { redactFeedbackLogs } from './help-settings'

it('redacts common credentials without destroying useful error diagnostics', () => {
  const secret = 'private-credential-value'
  const source = `HTTP 503: upstream unavailable; token=${secret} Authorization: Bearer ${secret}`
  const result = redactFeedbackLogs(source)
  expect(result).not.toContain(secret)
  expect(result).toContain('HTTP 503: upstream unavailable')
})
