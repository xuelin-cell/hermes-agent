import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getCronJobs = vi.fn()
const getCronJobRuns = vi.fn()
const { trySkillInNewChat } = vi.hoisted(() => ({ trySkillInNewChat: vi.fn() }))

vi.mock('@/hermes', async importOriginal => {
  const actual = await importOriginal()

  return {
    ...actual,
    getCronJobRuns: (...args: unknown[]) => getCronJobRuns(...args),
    getCronJobs: (...args: unknown[]) => getCronJobs(...args)
  }
})

vi.mock('../../capabilities/skills-mt/try-skill', () => ({ trySkillInNewChat }))

import { $cronJobs } from '@/store/cron'

import { ScheduledTasksView } from './scheduled-tasks-view'

const job = {
  enabled: true,
  id: 'daily-briefing',
  name: 'Daily briefing',
  prompt: "Summarize today's priority work.",
  schedule: { expr: '0 9 * * *', kind: 'cron' },
  state: 'scheduled'
} as never

describe('ScheduledTasksView run now', () => {
  beforeEach(() => {
    getCronJobRuns.mockReset()
    getCronJobs.mockReset()
    trySkillInNewChat.mockReset()
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

  it('opens the task actions menu from the more button', async () => {
    render(<ScheduledTasksView />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0, ctrlKey: false })

    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeTruthy()
  })

  it('opens a new chat with an editable scheduled-task prompt from the conversation menu', async () => {
    render(<ScheduledTasksView />)

    const trigger = screen.getByRole('button', { name: 'New task options' })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add from conversation' }))

    expect(trySkillInNewChat).toHaveBeenCalledWith('Help me create a scheduled task: ')
  })

  it('shows every task run in the history tab and opens its conversation', async () => {
    const onOpenSession = vi.fn()

    const run = {
      ended_at: 1_700_000_023,
      id: 'cron_daily-briefing_1700000000',
      is_active: false,
      last_active: 1_700_000_023,
      source: 'cron',
      started_at: 1_700_000_000,
      title: 'Daily briefing'
    }

    getCronJobRuns.mockResolvedValue([run])

    render(<ScheduledTasksView onOpenSession={onOpenSession} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Run history' }))

    await waitFor(() => expect(getCronJobRuns).toHaveBeenCalledWith(job.id, 20))
    expect(screen.getByText('Task name')).toBeTruthy()
    expect(screen.getByText('Success')).toBeTruthy()
    expect(screen.getByText('23s')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open Daily briefing conversation' }))
    expect(onOpenSession).toHaveBeenCalledWith(run.id, run)
  })

  it('opens a task run collection before opening an individual run conversation', async () => {
    const onOpenSession = vi.fn()

    const profiledJob = { ...job, profile: 'personal' }

    const firstRun = {
      ended_at: 1_700_000_023,
      id: 'cron_daily-briefing_1700000000',
      is_active: false,
      last_active: 1_700_000_023,
      source: 'cron',
      started_at: 1_700_000_000,
      title: 'Daily briefing'
    }

    const secondRun = {
      ...firstRun,
      ended_at: 1_700_010_023,
      id: 'cron_daily-briefing_1700010000',
      last_active: 1_700_010_023,
      started_at: 1_700_010_000
    }

    getCronJobs.mockResolvedValue([profiledJob])
    $cronJobs.set([profiledJob])
    getCronJobRuns.mockResolvedValue([secondRun, firstRun])

    render(<ScheduledTasksView onOpenSession={onOpenSession} />)

    fireEvent.click(screen.getByText('Daily briefing'))

    await waitFor(() => expect(getCronJobRuns).toHaveBeenCalledWith(job.id, 20, 'personal'))
    expect(onOpenSession).not.toHaveBeenCalled()
    expect(screen.getAllByRole('button', { name: 'Open Daily briefing conversation' })).toHaveLength(2)

    fireEvent.click(screen.getAllByRole('button', { name: 'Open Daily briefing conversation' })[1])
    expect(onOpenSession).toHaveBeenCalledWith(firstRun.id, firstRun)
  })

  it('opens the only conversation directly for a one-shot task', async () => {
    const onOpenSession = vi.fn()

    const oneShotJob = {
      ...job,
      schedule: { kind: 'once', run_at: '2026-11-09T18:00:00' }
    }

    const run = {
      ended_at: 1_700_000_023,
      id: 'cron_daily-briefing_1700000000',
      is_active: false,
      last_active: 1_700_000_023,
      source: 'cron',
      started_at: 1_700_000_000,
      title: 'Daily briefing'
    }

    getCronJobs.mockResolvedValue([oneShotJob])
    $cronJobs.set([oneShotJob])
    getCronJobRuns.mockResolvedValue([run])

    render(<ScheduledTasksView onOpenSession={onOpenSession} />)

    fireEvent.click(screen.getByText('Daily briefing'))

    await waitFor(() => expect(getCronJobRuns).toHaveBeenCalledWith(job.id, 1))
    expect(onOpenSession).toHaveBeenCalledWith(run.id, run)
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
  })
})
