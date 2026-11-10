import { expect, it, vi } from 'vitest'
import { DesktopMessaging, MessagingBotIndex } from './messaging'

it('requires explicit confirmation and routes reset through the primary account queue', async () => {
  const request = vi.fn().mockResolvedValue({ ok: true, deleted: 2, name: null })
  const messaging = new DesktopMessaging({ account: 'test-account', index: {} as MessagingBotIndex, request })
  expect(() => messaging.submit({ operation: 'reset-history', confirmed: false })).toThrow()
  expect(request).not.toHaveBeenCalled()
  await messaging.submit({ operation: 'reset-history', profile: 'default', confirmed: true })
  await messaging.settle()
  expect(request).toHaveBeenCalledWith(
    'default',
    '/api/plugins/desktop-messaging/reset-history',
    'POST',
    { confirmed: true },
    120000
  )
  expect(messaging.status().phase).toBe('completed')
})
