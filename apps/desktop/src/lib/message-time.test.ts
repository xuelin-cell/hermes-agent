import { expect, it } from 'vitest'

import { formatFooterTime, parseMessageTime } from './message-time'

it('formats local calendar dates like Uniwork and rejects missing or invalid timestamps', () => {
  const now = new Date(2026, 10, 4, 9, 0)
  const seconds = (date: Date) => date.getTime() / 1000
  expect(formatFooterTime(seconds(new Date(2026, 10, 4, 15, 55)), 'zh', '昨天', now)).toBe('15:55')
  expect(formatFooterTime(seconds(new Date(2026, 10, 3, 23, 50)), 'zh', '昨天', now)).toBe('昨天 23:50')
  expect(formatFooterTime(seconds(new Date(2026, 10, 1, 15, 55)), 'zh', '昨天', now)).toBe('11月1日 15:55')
  expect(formatFooterTime(seconds(new Date(2025, 11, 31, 15, 55)), 'zh', '昨天', now)).toBe('2025年12月31日 15:55')
  expect(formatFooterTime(seconds(new Date(2026, 10, 4, 15, 55)), 'en', 'Yesterday', now)).toBe('15:55')
  expect(formatFooterTime(seconds(new Date(2026, 10, 3, 15, 55)), 'en', 'Yesterday', now)).toBe('Yesterday 15:55')

  for (const value of [undefined, null, 0, -1, NaN, Infinity, 1e20, '2026-11-04']) {
    expect(parseMessageTime(value)).toBeUndefined()
    expect(formatFooterTime(value, 'zh', '昨天', now)).toBe('')
  }
})
