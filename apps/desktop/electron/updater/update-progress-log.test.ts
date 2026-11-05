import { describe, expect, it } from 'vitest'

import { formatUpdateProgressLine, shouldLogUpdateProgress, type UpdateProgressLogPoint } from './update-progress-log'

const fetchPoint = (percent: number | null): UpdateProgressLogPoint => ({
  stage: 'fetch',
  message: 'Downloading the Hermes update.',
  percent
})

describe('update progress logging', () => {
  it('collapses a chunk-by-chunk download into step lines instead of one per event', () => {
    // Contract: a 0→100% download yields a bounded number of lines, and every
    // kept line carries the percent it was kept for. electron-updater emits
    // 'download-progress' per chunk, so the raw stream is thousands of
    // identical lines (24k in one observed desktop.log).
    let last: UpdateProgressLogPoint | null = null
    const logged: UpdateProgressLogPoint[] = []

    for (let percent = 0; percent <= 100; percent += 0.37) {
      const point = fetchPoint(Math.min(percent, 100))

      if (shouldLogUpdateProgress(last, point)) {
        last = point
        logged.push(point)
      }
    }

    expect(logged.length).toBeLessThanOrEqual(12)
    expect(logged.length).toBeGreaterThanOrEqual(2)

    for (let i = 1; i < logged.length; i++) {
      expect(logged[i].percent! - logged[i - 1].percent!).toBeGreaterThanOrEqual(10)
    }
  })

  it('always records a stage or message change, and a percent that went backwards', () => {
    const fetch = fetchPoint(40)

    expect(shouldLogUpdateProgress(fetch, fetchPoint(41))).toBe(false)
    expect(shouldLogUpdateProgress(fetch, { ...fetchPoint(45), stage: 'restart' })).toBe(true)
    expect(shouldLogUpdateProgress(fetch, { ...fetchPoint(45), message: 'Downloading the full update.' })).toBe(true)
    // Differential → full restart rewinds the counter; that is evidence.
    expect(shouldLogUpdateProgress(fetch, fetchPoint(2))).toBe(true)
    // A stage with no percentage says the same thing twice.
    const restart: UpdateProgressLogPoint = { stage: 'restart', message: 'Restarting.', percent: null }
    expect(shouldLogUpdateProgress(restart, restart)).toBe(false)
  })

  it('renders percent only when the point carries one', () => {
    expect(formatUpdateProgressLine(fetchPoint(40))).toBe('[updates] fetch: Downloading the Hermes update. (40%)')
    expect(formatUpdateProgressLine({ stage: 'manual', message: '', percent: null }, 'hermes update')).toBe(
      '[updates] manual: hermes update'
    )
  })
})
