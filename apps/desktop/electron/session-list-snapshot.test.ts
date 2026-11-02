import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

import { readSessionListSnapshot, sessionListSnapshotScope, writeSessionListSnapshot } from './session-list-snapshot'

it('restores a bounded history from disk without a backend and isolates account and route owners', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-snapshot-'))

  try {
    const a = path.join(root, 'account-a')
    const b = path.join(root, 'account-b')
    const local = sessionListSnapshotScope({ connection: 'local', profile: 'all' })
    const remote = sessionListSnapshotScope({ connection: 'remote', profile: 'all' })
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `chat-${i}`, source: 'desktop', message_count: 4, last_active: i, title: `History ${i}` }))
    await writeSessionListSnapshot(a, local, { scope: local, rows })
    expect((await readSessionListSnapshot(b, local)).rows).toEqual([])
    expect((await readSessionListSnapshot(a, remote)).rows).toEqual([])
    await writeSessionListSnapshot(a, remote, { scope: local, rows })
    expect((await readSessionListSnapshot(a, remote)).rows).toEqual([])
    const started = performance.now()
    expect((await readSessionListSnapshot(a, local)).rows).toEqual(rows)
    expect(performance.now() - started).toBeLessThan(3000)
    await writeSessionListSnapshot(a, local, { scope: local, rows: [] })
    expect((await readSessionListSnapshot(a, local)).rows).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
