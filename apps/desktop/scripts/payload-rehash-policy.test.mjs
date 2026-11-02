import { expect, test } from 'vitest'
import { shouldRehashPayload } from './payload-rehash-policy.mjs'

// Assembly always writes the stamp, so the only reasons to redo the ~1.5 GiB
// tool hash are "something signed" and "something edited a PE in place".

test('an unsigned build that repaired nothing keeps the stage-time digests', () => {
  expect(shouldRehashPayload({ signSkipped: true, repairedCount: 0, stampExists: true })).toBe(false)
})

test('signing rewrites shipped bytes, so the digests are recomputed', () => {
  expect(shouldRehashPayload({ signSkipped: false, repairedCount: 0, stampExists: true })).toBe(true)
})

test('an in-place certificate-table repair invalidates the stamp even when unsigned', () => {
  expect(shouldRehashPayload({ signSkipped: true, repairedCount: 1, stampExists: true })).toBe(true)
})

test('a missing stamp forces the recompute', () => {
  expect(shouldRehashPayload({ signSkipped: true, repairedCount: 0, stampExists: false })).toBe(true)
})
