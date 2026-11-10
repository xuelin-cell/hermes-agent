/**
 * Startup marks for surfaces that run BEFORE the chat runtime is loaded.
 *
 * The chat runtime owns `desktop.log`, but the login shell starts first and its
 * window is what the user waits on — so its phases need the same timeline. The
 * log path is handed over by the runtime once it loads; until then the login
 * shell points the marks at its own file.
 *
 * Every mark carries its own timestamp, so a mark written to a different file
 * than the rest of the run still reads in the right place on the timeline.
 */

import fs from 'node:fs'
import path from 'node:path'

import { formatDesktopLogLine } from './desktop-log-line'

// Same baseline the chat runtime uses: the main process start (Electron's own
// boot included), not this module's import time.
const STARTED_AT = Date.now() - Math.round(process.uptime() * 1000)

let logPath: string | null = null

/** Point the startup marks at a log file (the runtime hands over its own). */
export function setDesktopLogPath(next: string | null): void {
  logPath = next
}

/**
 * Record one startup stage. Never throws: logging must not break startup.
 */
export function startupMark(stage: string, detail?: string): void {
  if (!logPath) {
    return
  }

  const at = Date.now()
  const suffix = detail ? ` ${detail}` : ''

  const line = formatDesktopLogLine(
    `[startup] ${stage} at +${Math.round(at - STARTED_AT)}ms (since main process start, ${new Date(at).toISOString()})${suffix}`
  )

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, `${line}\n`)
  } catch {
    // Logging must never block the login shell.
  }
}
