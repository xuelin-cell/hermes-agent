import { expect, it } from 'vitest'

import { TelemetryInputs } from './inputs'

it('input summaries are scoped to profile and occurrence; ambiguous hashes never guess the newest input', () => {
  const inputs = new TelemetryInputs()
  const requestHash = 'f'.repeat(64)
  inputs.remember('a', { id: 'one', profile: 'default', sessionId: 's', requestHash, requestKind: 'user', userInput: '/write hello\u0000' })
  inputs.remember('b', { id: 'two', profile: 'expert', sessionId: 's', requestHash, requestKind: 'user', userInput: '😀'.repeat(2200) })
  expect(inputs.find('a', requestHash, 'turn-one', ['another-session'])).toEqual({})
  expect(inputs.find('a', requestHash, 'turn-one', ['s'])).toEqual({ submissionId: 'one', requestKind: 'user',
    userInput: '/write hello', recordedAt: expect.any(Number) })
  expect(inputs.find('a', requestHash, 'turn-two', ['s'])).toEqual({})
  expect(Array.from(inputs.find('b', requestHash, 'turn-b', ['s']).userInput!)).toHaveLength(2000)
  inputs.remember('a', { id: 'three', profile: 'default', sessionId: 's', requestHash, requestKind: 'user', userInput: 'first' })
  inputs.remember('a', { id: 'four', profile: 'default', sessionId: 's', requestHash, requestKind: 'user', userInput: 'second' })
  expect(inputs.find('a', requestHash, 'ambiguous', ['s'])).toEqual({})
})

it('never retains hidden system text and carries an explicit recovery reference', () => {
  const inputs = new TelemetryInputs()
  const requestHash = 'f'.repeat(64)
  inputs.remember('a', { id: 'resume', profile: 'default', sessionId: 's', requestHash,
    requestKind: 'resume', resumeFrom: 'a'.repeat(64), userInput: 'SYSTEM NOTE' })
  expect(inputs.find('a', requestHash, 't', ['s'])).toEqual({
    submissionId: 'resume', requestKind: 'resume', resumeFrom: 'a'.repeat(64), recordedAt: expect.any(Number)
  })
  expect(inputs.find('b', requestHash, 't', ['s'])).toEqual({})
})
