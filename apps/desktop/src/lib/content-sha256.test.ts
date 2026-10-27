import { createHash, webcrypto } from 'node:crypto'

import { afterEach, expect, it, vi } from 'vitest'

import { contentSha256 } from './content-sha256'

afterEach(() => vi.unstubAllGlobals())

it('hashes the same UTF-8 bytes on HTTPS and plain HTTP', async () => {
  const text = '<h1>你好 🌏</h1>\n'
  const expected = createHash('sha256').update(text).digest('hex')
  vi.stubGlobal('crypto', webcrypto)
  expect(await contentSha256(text)).toBe(expected)
  vi.stubGlobal('crypto', {})
  expect(await contentSha256(text)).toBe(expected)
})
