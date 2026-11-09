import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getCronJobs = vi.fn()
const getCronJobRuns = vi.fn()

vi.mock('@/hermes', async importOriginal => {
  const actual = await importOriginal()

  return {
    ...actual,
    getCronJobRuns: (...args: unknown[]) => getCronJobRuns(...args),
    getCronJobs: (...args: unknown[]) => getCronJobs(...args)
  }
})

import { $cronJobs } from '@/store/cron'

import { ScheduledTasksView } from './scheduled-tasks-view'

const job = {
  enabled: true,
  id: 'daily-briefing',
  name: 'Daily briefing',
  prompt: 'Summarize today\'s priority work.',
  schedule: { expr: '0 9 * * *', kind: 'cron' },
  state: 'scheduled'
} as never

describe('ScheduledTasksView run now', () => {
  beforeEach(() => {
    getCronJobRuns.mockReset()
    getCronJobs.mockReset()
    getCronJobs.mockResolvedValue([job])
    $cronJobs.set([job])
  })

  afterEach(() => {
    cleanup()
    $cronJobs.set([])
  })

  it('opens a fresh chat by submitting the scheduled task prompt', async () => {
    const onRunTask = vi.fn().mockResolvedValue(true)

    render(<ScheduledTasksView onRunTask={onRunTask} />)

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))

    await waitFor(() => expect(onRunTask).toHaveBeenCalledWith(job.prompt))
    expect(getCronJobRuns).not.toHaveBeenCalled()
  })
})
