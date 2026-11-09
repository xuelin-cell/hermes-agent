import { describe, expect, it } from 'vitest'

import { DownloadCancellation } from './download-cancellation'

describe('DownloadCancellation', () => {
  // The HTTP executor runs every buffer download (blockmap fetch, full-download
  // fallback) through `createPromise` and aborts the request from its cancel
  // listener; a token without it fails those transfers outright.
  it('aborts the request registered on the token and rejects it', async () => {
    const token = new DownloadCancellation()
    const aborted: string[] = []

    const pending = token.createPromise<string>((_resolve, _reject, onCancel) => {
      onCancel((): void => {
        aborted.push('abort')
      })
    })

    expect(token.cancel()).toBe(true)
    await expect(pending).rejects.toThrow('cancelled')
    expect(aborted).toEqual(['abort'])
    // Nothing left to abort once the flag is set.
    expect(token.cancel()).toBe(false)
  })

  it('rejects a request started after the cancel and settles a finished one normally', async () => {
    const cancelled = new DownloadCancellation()
    cancelled.cancel()

    await expect(cancelled.createPromise<string>(() => {})).rejects.toThrow('cancelled')

    const finished = new DownloadCancellation()

    await expect(finished.createPromise<number>(resolve => resolve(7))).resolves.toBe(7)
    expect(finished.cancel()).toBe(true)
  })

  it('ignores a request that settles before the cancel', async () => {
    const token = new DownloadCancellation()
    let finish: (() => void) | null = null

    const pending = token.createPromise<string>(resolve => {
      finish = (): void => resolve('done')
    })

    finish!()
    await expect(pending).resolves.toBe('done')
    // The settled request is no longer registered, so the cancel has nothing to
    // reach — the strategy's own transfer bookkeeping is what decides whether a
    // cancel is still meaningful.
    expect(token.cancel()).toBe(true)
  })
})
