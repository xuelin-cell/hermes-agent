import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Opaque identity shared by the running-turn bridge and the desktop recovery record. */
export function interruptedExecutionId(home: string, sessionId: string, marker: Record<string, unknown>): string | undefined {
  const started = marker.started_at
  const pid = marker.writer_pid

  if (typeof started !== 'number' || !Number.isFinite(started) || started <= 0 ||
      typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {return}

  const resolved = path.resolve(home)
  const scope = process.platform === 'win32' ? resolved.toLowerCase() : resolved

  return createHash('sha256').update(JSON.stringify([scope, sessionId, started, pid, marker.writer_start_time ?? null])).digest('hex')
}

/** A stale marker or ambiguous alias is not evidence that it owns this request. */
export function currentExecutionId(home: string, sessions: string[], requestHash: string,
  window: { recordedAt?: number; observedAt?: number; writerPid?: number }): string | undefined {
  if (typeof window.recordedAt !== 'number' || typeof window.observedAt !== 'number' ||
      !Number.isFinite(window.observedAt) || !Number.isSafeInteger(window.writerPid)) {return}

  try {
    const markers = JSON.parse(fs.readFileSync(path.join(home, 'desktop/interrupted_turns.json'), 'utf8'))
    const matches = new Set<string>()

    for (const session of sessions) {
      const marker = markers?.[session]

      if (!marker || typeof marker.prompt !== 'string' ||
          createHash('sha256').update(marker.prompt).digest('hex') !== requestHash) {continue}

      // The writer queue can lag behind a later turn with identical text. Never borrow that turn's marker.
      if (marker.writer_pid !== window.writerPid || typeof marker.started_at !== 'number' ||
          marker.started_at * 1000 < window.recordedAt || marker.started_at > window.observedAt) {continue}

      const id = interruptedExecutionId(home, session, marker)

      if (id) {matches.add(id)}
    }

    return matches.size === 1 ? [...matches][0] : undefined
  } catch {return undefined}
}
