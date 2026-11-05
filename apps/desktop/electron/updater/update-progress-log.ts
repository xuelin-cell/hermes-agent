// Updater progress → desktop.log rate limit.
//
// electron-updater emits 'download-progress' once per downloaded chunk (many
// times a second), and every arm forwards each event to `emitUpdateProgress`,
// which logs it. One 1.5 GB download therefore wrote ~24k identical
// "fetch: Downloading the Hermes update." lines — 24 730 of 32 241 lines in a
// single desktop.log — burying every other forensic line and rotating the
// useful history out of the file.
//
// The renderer stream is untouched (the progress bar wants every tick); only
// the log is bounded: a stage/message change is always recorded, progress
// inside one stage lands once per step, and a percent that goes BACKWARD
// (differential → full restart) is recorded because it changes what happened.

export interface UpdateProgressLogPoint {
  stage: string
  message: string
  percent: number | null
}

/** Log at most one line per this many percent of download progress. */
export const PROGRESS_LOG_PERCENT_STEP = 10

export function shouldLogUpdateProgress(
  previous: UpdateProgressLogPoint | null,
  next: UpdateProgressLogPoint
): boolean {
  if (!previous) {
    return true
  }

  if (previous.stage !== next.stage || previous.message !== next.message) {
    return true
  }

  // Same stage and copy: only a numeric percent can add anything.
  if (typeof next.percent !== 'number') {
    return false
  }

  if (typeof previous.percent !== 'number') {
    return true
  }

  return next.percent - previous.percent >= PROGRESS_LOG_PERCENT_STEP || next.percent < previous.percent
}

/** `[updates] fetch: Downloading the Hermes update. (40%)` */
export function formatUpdateProgressLine(point: UpdateProgressLogPoint, error?: string | null): string {
  const percent = typeof point.percent === 'number' ? ` (${Math.round(point.percent)}%)` : ''

  return `[updates] ${point.stage}: ${point.message || error || ''}${percent}`
}
