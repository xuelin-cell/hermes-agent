import { expect, it, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<unknown>>())
vi.mock('electron', () => ({
  app: { getVersion: () => 'test-version' },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(name, handler) }
}))
import { registerSettingsFeedback } from './settings-feedback'

it('uploads only on request, binds the current account and sends a real diagnostic zip', async () => {
  const account = { uid: 'test-user', token: 'test-secret', phone: '123', maskedPhone: '1**', expiresAt: 0 }
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 200 }), { status: 200 }))
  vi.stubGlobal('fetch', request)
  try {
    registerSettingsFeedback(() => account)
    expect(request).not.toHaveBeenCalled()
    const bytes = zipSync({ 'report.txt': strToU8('diagnostic report') })
    await handlers.get('hermes:settings:feedback')!({}, { bytes, description: 'test report', date: '2026-11-09' })
    const [url, init] = request.mock.calls[0]
    expect(url).toBe('https://maas.ai-yuanjing.com/app/gateway/uniclaw/feedback/upload')
    expect(init.headers.Authorization).toBe(`Bearer ${account.token}`)
    expect(init.body.get('description')).toBe('test report')
    expect(new Uint8Array(await init.body.get('file').arrayBuffer())).toEqual(bytes)
    registerSettingsFeedback(() => null)
    await expect(handlers.get('hermes:settings:feedback')!({}, { bytes, description: '', date: '' })).rejects.toThrow(
      'Sign in'
    )
    expect(request).toHaveBeenCalledTimes(1)
  } finally {
    vi.unstubAllGlobals()
  }
})
