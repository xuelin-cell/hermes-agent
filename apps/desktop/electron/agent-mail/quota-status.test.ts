import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { withWoMailQuota } from '../../services/open-connector/src/providers/wo_mail/quota'

import { readAgentMailQuotaStatus } from './quota-status'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reads the connector-owned quota ledger without mutating it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-mail-quota-status-'))
  directories.push(directory)
  const now = new Date(2026, 9, 20, 12)

  await withWoMailQuota(directory, '13800138000@wo.cn', async () => ({ ok: true }), now)

  expect(readAgentMailQuotaStatus(directory, '13800138000@wo.cn', now)).toEqual({
    dailyQuota: 50,
    todaySent: 1
  })
  expect(readAgentMailQuotaStatus(directory, '13900139000@wo.cn', now)).toEqual({
    dailyQuota: 50,
    todaySent: 0
  })
})
