import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'vitest'

import { readAgentMailQuotaStatus } from './quota-status'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reads the connector-owned quota ledger without mutating it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-mail-quota-status-'))
  directories.push(directory)
  const now = new Date(2026, 9, 20, 12)
  const salt = 'a'.repeat(64)
  const account = createHash('sha256').update(`${salt}\0${'13800138000@wo.cn'}`).digest('hex')

  writeFileSync(
    join(directory, 'agent-mail-quota.json'),
    JSON.stringify({ version: 1, salt, accounts: { [account]: { date: '2026-10-20', sent: 1 } } })
  )

  expect(readAgentMailQuotaStatus(directory, '13800138000@wo.cn', now)).toEqual({
    dailyQuota: 50,
    todaySent: 1
  })
  expect(readAgentMailQuotaStatus(directory, '13900139000@wo.cn', now)).toEqual({
    dailyQuota: 50,
    todaySent: 0
  })
})
