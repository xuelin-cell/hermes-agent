import { afterEach, expect, it, vi } from 'vitest'
import { storeBrowserLogin } from '../../../shared/src/browser-maas-auth.js'
import { browserMail, openMailAttachment } from './browser-mail'

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('binds mailbox requests to browser login and resolves only Entry attachment URLs', async () => {
  storeBrowserLogin('/hermes/', { maas_auth: { token: 'maas-alice', loginId: 'alice', expiresAt: Date.now() + 60000 } })
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    status: { email: '13800001111@wo.cn', enabled: true },
    data: { file: { downloadUrl: '/hermes/__hermes_backend/api/plugins/cloud-mail/attachments/file' } }
  }), { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  const bridge = browserMail('/hermes/')
  const input = { profile: 'default', operation: 'action' as const, action: 'download_attachment' as const,
    input: { folder: 'INBOX', uid: 1, attachmentId: '2' } }
  const result = await bridge.agentMail(input)
  const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe(location.origin + '/hermes/__entry/mail')
  expect(new Headers(request.headers).get('Authorization')).toBe('Bearer maas-alice')
  expect(request.credentials).toBe('same-origin')
  expect(JSON.parse(request.body as string)).toEqual(input)
  expect((result.data as { file: { downloadUrl: string } }).file.downloadUrl).toBe(location.origin + '/hermes/__hermes_backend/api/plugins/cloud-mail/attachments/file')
  localStorage.clear()
  await expect(bridge.agentMail({ operation: 'enable', profile: 'default' })).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('hands only same-origin mailbox attachments to the browser download action', () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
  const url = location.origin + '/hermes/__hermes_backend/api/plugins/cloud-mail/attachments/file'
  expect(openMailAttachment('/hermes/', url)).toBe(true)
  expect(click).toHaveBeenCalledTimes(1)
  expect(openMailAttachment('/hermes/', 'https://outside.example/file')).toBe(false)
  expect(openMailAttachment('/hermes/', location.origin + '/other')).toBe(false)
  expect(openMailAttachment('/hermes/', url + '?url=https://outside.example')).toBe(false)
  expect(click).toHaveBeenCalledTimes(1)
})
