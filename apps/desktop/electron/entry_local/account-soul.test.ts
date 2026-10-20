import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

import { prepareAccountSoul } from './account-soul'

it('seeds each account independently and preserves custom identities when returning to an account', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uniwork-soul-'))
  const first = path.join(root, 'a')
  const second = path.join(root, 'b')
  fs.mkdirSync(first)
  fs.mkdirSync(second)

  try {
    prepareAccountSoul(first)
    const original = fs.readFileSync(path.join(first, 'SOUL.md'), 'utf8')
    expect(original).toContain('我是元景数字员工')
    fs.writeFileSync(path.join(first, 'SOUL.md'), '我的定制身份')
    prepareAccountSoul(second)
    expect(fs.readFileSync(path.join(second, 'SOUL.md'), 'utf8')).toBe(original)
    prepareAccountSoul(first)
    expect(fs.readFileSync(path.join(first, 'SOUL.md'), 'utf8')).toBe('我的定制身份')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
