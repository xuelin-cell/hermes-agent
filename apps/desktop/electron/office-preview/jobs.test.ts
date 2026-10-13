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
