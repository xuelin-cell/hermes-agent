import { describe, expect, it, vi } from 'vitest'

import { OfficePreviewJobs } from './jobs'

/** 用事件控制任务完成，不依赖机器负载或真实计时等待。 */
function gate<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(finish => {
    resolve = finish
  })

  return { promise, resolve }
}

describe('Office preview jobs', () => {
  it('coalesces identical pending jobs and preserves the result after one caller leaves', async () => {
    const jobs = new OfficePreviewJobs<string>()
    const pending = gate<string>()
    const work = vi.fn(() => pending.promise)
    const first = jobs.run('account-A', 'file-version', work)
    expect(jobs.run('account-A', 'file-version', vi.fn())).toBe(first)
    await Promise.resolve()
    expect(work).toHaveBeenCalledTimes(1)
    pending.resolve('converted PDF')
    await expect(first).resolves.toBe('converted PDF')
    const next = vi.fn(async () => 'next result')
    await expect(jobs.run('account-A', 'file-version', next)).resolves.toBe('next result')
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('serializes different files and does not merge equal versions belonging to different accounts', async () => {
    const jobs = new OfficePreviewJobs<string>()
    const pending = gate<string>()
    const order: string[] = []

    const first = jobs.run('account-A', 'same-key', () => {
      order.push('A')

      return pending.promise
    })

    const second = jobs.run('account-B', 'same-key', async () => {
      order.push('B')

      return 'B PDF'
    })

    const third = jobs.run('account-A', 'different-key', async () => {
      order.push('C')

      return 'C PDF'
    })

    await Promise.resolve()
    expect(order).toEqual(['A'])
    pending.resolve('A PDF')
    expect(await Promise.all([first, second, third])).toEqual(['A PDF', 'B PDF', 'C PDF'])
    expect(order).toEqual(['A', 'B', 'C'])
  })

  it('skips a queued job once every requester has left, but finishes a job that has started', async () => {
    const jobs = new OfficePreviewJobs<string>()
    const running = gate<string>()
    const viewing = new AbortController()
    const started = jobs.run('account-A', 'viewing', () => running.promise, viewing.signal)

    const left = new AbortController()
    const abandonedWork = vi.fn(async () => 'nobody is waiting')
    const abandoned = jobs.run('account-A', 'abandoned', abandonedWork, left.signal)
    const stillWanted = new AbortController()
    const sharedWork = vi.fn(async () => 'shared PDF')
    const shared = jobs.run('account-A', 'shared', sharedWork, new AbortController().signal)
    jobs.run('account-A', 'shared', vi.fn(), stillWanted.signal)

    await Promise.resolve()
    left.abort()
    viewing.abort()
    running.resolve('started PDF')

    await expect(started).resolves.toBe('started PDF')
    await expect(abandoned).rejects.toMatchObject({ code: 'unavailable' })
    expect(abandonedWork).not.toHaveBeenCalled()
    await expect(shared).resolves.toBe('shared PDF')
    expect(sharedWork).toHaveBeenCalledTimes(1)
  })

  it('releases failed work, starts the next job and allows an explicit retry', async () => {
    const jobs = new OfficePreviewJobs<string>()

    const first = jobs.run('account-A', 'bad', async () => {
      throw new Error('conversion failed')
    })

    const second = jobs.run('account-A', 'good', async () => 'good PDF')
    await expect(first).rejects.toThrow('conversion failed')
    await expect(second).resolves.toBe('good PDF')
    await expect(jobs.run('account-A', 'bad', async () => 'retry PDF')).resolves.toBe('retry PDF')
  })
})
