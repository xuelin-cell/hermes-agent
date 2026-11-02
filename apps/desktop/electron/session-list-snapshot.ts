import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { SessionListSnapshot } from './session-list-snapshot-contract'

export function sessionListSnapshotScope(owner: unknown): string {
  return createHash('sha256').update(JSON.stringify(owner)).digest('hex')
}

function validRows(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length <= 100 && value.every(row =>
    row && typeof row.id === 'string' && typeof row.source === 'string' &&
    typeof row.message_count === 'number' && typeof row.last_active === 'number'
  )
}

/** Account home and routing fingerprint keep cached titles inside their owner. */
export async function readSessionListSnapshot(home: string, scope: string): Promise<SessionListSnapshot> {
  try {
    const value = JSON.parse(await readFile(path.join(home, 'cache', 'session-lists', `${scope}.json`), 'utf8'))

    if (value.version === 1 && validRows(value.rows)) {
      return { scope, rows: value.rows }
    }
  } catch {
    // A first launch, interrupted write, or unavailable cache falls back to the live list.
  }

  return { scope, rows: [] }
}

export async function writeSessionListSnapshot(home: string, scope: string, snapshot: SessionListSnapshot): Promise<void> {
  if (snapshot?.scope !== scope || !validRows(snapshot.rows)) {
    return
  }

  const directory = path.join(home, 'cache', 'session-lists')
  await mkdir(directory, { recursive: true })
  const target = path.join(directory, `${scope}.json`)
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify({ version: 1, rows: snapshot.rows }), 'utf8')
  await rename(temporary, target)
}
