import { afterEach, expect, it, vi } from 'vitest'

import { rememberUsageInput } from './usage-input'

afterEach(() => vi.unstubAllGlobals())

it('records only a hash and visible input; recording failure does not reject the chat send', async () => {
  const record = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).buffer) } })
  const previous = window.hermesDesktop
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { rememberUsageInput: record } })

  try {
    await rememberUsageInput('send', 'expert', 'session', 'EXPANDED SKILL AND ATTACHMENTS', '/write hello')
    expect(record).toHaveBeenCalledWith({ id: 'send', profile: 'expert', sessionId: 'session', requestHash: '0'.repeat(64), requestKind: 'user', userInput: '/write hello' })
    record.mockRejectedValue(new Error('closed'))
    await expect(rememberUsageInput('again', 'expert', 'session', 'request', 'visible')).resolves.toBeUndefined()
  } finally {
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: previous })
  }
})
