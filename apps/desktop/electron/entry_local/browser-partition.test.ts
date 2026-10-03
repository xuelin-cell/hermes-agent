import path from 'node:path'

import { expect, test } from 'vitest'

import { resolveAccountPaths } from './account-paths'
import { accountBrowserPartition } from './browser-partition'

test('账号浏览器分区稳定且保持用途隔离，Windows 名称不含转义字符', () => {
  const roots = { data: path.resolve('fixture-data'), userData: path.resolve('fixture-state') }
  const a = resolveAccountPaths(roots, 'fixture-platform', 'A')
  const b = resolveAccountPaths(roots, 'fixture-platform', 'B')

  const purposes = [
    'persist:desktop',
    'persist:hermes-preview',
    'persist:hermes-remote-oauth',
    'persist:hermes-remote-oauth-conn-same',
    'persist:hermes-embed',
    'hermes:link-titles'
  ]

  const partitions = purposes.map(purpose => accountBrowserPartition(a, purpose))

  expect(new Set(partitions).size).toBe(purposes.length)

  for (const [index, purpose] of purposes.entries()) {
    const partition = partitions[index]

    expect(accountBrowserPartition(a, purpose)).toBe(partition)
    expect(accountBrowserPartition(b, purpose)).not.toBe(partition)
    expect(partition.startsWith('persist:')).toBe(purpose.startsWith('persist:'))
    expect(partition.replace(/^persist:/, '')).toMatch(/^[a-z0-9-]+$/)
    expect(partition.replace(/^persist:/, '').length).toBeLessThanOrEqual(80)
  }
})
