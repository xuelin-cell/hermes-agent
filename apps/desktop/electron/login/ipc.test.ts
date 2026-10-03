import { EventEmitter } from 'node:events'

import { expect, it, vi } from 'vitest'

const { handle, removeHandler, fetch, save, load } = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  fetch: vi.fn(),
  save: vi.fn(),
  load: vi.fn().mockReturnValue(null)
}))

vi.mock('electron', () => ({
  ipcMain: { handle, removeHandler },
  net: { fetch },
  app: { getPath: () => 'fixture-only' }
}))
vi.mock('./credential-store', () => ({
  CredentialStore: vi.fn(function () {
    return { save, load }
  })
}))

import { CAPTCHA_CHANNEL, LOGIN_CHANNEL, PLAN_CHANNEL, RESTORE_CHANNEL, SEND_SMS_CHANNEL } from './contract'
import { installLoginIpc } from './ipc'

it('只接受绑定窗口主框架的固定登录页与约定参数，关闭后注销', async () => {
  const frame = { url: 'file:///test/login.html' }
  const contents = { mainFrame: frame }
  const window = Object.assign(new EventEmitter(), { isDestroyed: (): boolean => false, webContents: contents })
  installLoginIpc(window as never, frame.url)
  const handler = handle.mock.calls[0][1]
  const send = handle.mock.calls[1][1]
  const login = handle.mock.calls[2][1]
  const restore = handle.mock.calls[3][1]
  const plan = handle.mock.calls[4][1]
  const input = { phone: '13800000000', captchaCode: 'abcd', captchaId: 'id' }
  const event = { sender: contents, senderFrame: frame }

  for (const invalid of [
    { ...event, sender: {} },
    { ...event, senderFrame: { url: frame.url } }
  ]) {
    expect(await handler(invalid)).toEqual({ ok: false })
    expect(await send(invalid, input)).toEqual({ ok: false, error: 'invalid' })
    expect(await login(invalid, { phone: input.phone, smsCode: '123456' })).toEqual({ ok: false })
    expect(await restore(invalid)).toEqual({ ok: false })
    expect(await plan(invalid)).toEqual({ status: 'failed' })
  }

  expect(await handler(event, 'https://attacker.invalid')).toEqual({ ok: false })
  expect(await send(event, input, 'extra')).toEqual({ ok: false, error: 'invalid' })
  expect(await send(event)).toEqual({ ok: false, error: 'invalid' })
  expect(await login(event)).toEqual({ ok: false })
  expect(await login(event, {}, 'extra')).toEqual({ ok: false })
  expect(await restore(event, { uid: 'forged', token: 'forged' })).toEqual({ ok: false })
  expect(await plan(event, 'forged-token')).toEqual({ status: 'failed' })
  expect(load).not.toHaveBeenCalled()
  frame.url = 'file:///test/other.html'
  expect(await handler(event)).toEqual({ ok: false })
  expect(await send(event, input)).toEqual({ ok: false, error: 'invalid' })
  expect(await login(event, { phone: input.phone, smsCode: '123456' })).toEqual({ ok: false })
  expect(await restore(event)).toEqual({ ok: false })
  expect(await plan(event)).toEqual({ status: 'failed' })
  expect(fetch).not.toHaveBeenCalled()
  frame.url = 'file:///test/login.html'
  expect(await plan(event)).toEqual({ status: 'failed' })
  expect(fetch).not.toHaveBeenCalled()
  expect(await restore(event)).toEqual({ ok: false })
  expect(load).toHaveBeenCalledTimes(1)
  fetch.mockResolvedValue(Response.json({ code: 0, data: { captchaId: 'id', b64s: 'data:image/png;base64,aGVsbG8=' } }))
  expect((await handler(event)).ok).toBe(true)
  fetch.mockResolvedValueOnce(Response.json({ code: 0 }))
  expect((await send(event, input)).ok).toBe(true)
  fetch.mockResolvedValueOnce(Response.json({ code: 0, data: { uid: 'id', token: 'private-token', expireIn: 60 } }))
  const logged = await login(event, { phone: input.phone, smsCode: '123456' })
  expect(logged.ok).toBe(true)
  expect(Object.keys(logged.account)).toEqual(['maskedPhone', 'expiresAt'])
  expect(await restore(event)).toEqual(logged)
  expect(load).toHaveBeenCalledTimes(1)
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ uid: 'id', token: 'private-token' }))
  fetch.mockResolvedValueOnce(
    Response.json({
      apiKey: 'private-model-key',
      models: { models: [{ model: 'name', base_url: 'https://models.invalid/private-path' }] }
    })
  )
  expect(await plan(event)).toEqual({ status: 'available', models: [{ name: 'name', isDefault: true }] })
  expect(fetch.mock.calls[3][1].headers.Authorization).toBe('Bearer private-token')
  fetch.mockResolvedValueOnce(new Response('private-error', { status: 500 }))
  expect(await plan(event)).toEqual({ status: 'failed' })
  expect(await restore(event)).toEqual(logged)
  window.isDestroyed = () => true
  expect(await handler(event)).toEqual({ ok: false })
  expect(await send(event, input)).toEqual({ ok: false, error: 'invalid' })
  expect(await login(event, {})).toEqual({ ok: false })
  expect(await restore(event)).toEqual({ ok: false })
  expect(await plan(event)).toEqual({ status: 'failed' })
  expect(fetch).toHaveBeenCalledTimes(5)
  window.emit('closed')
  expect(removeHandler).toHaveBeenCalledWith(CAPTCHA_CHANNEL)
  expect(removeHandler).toHaveBeenCalledWith(SEND_SMS_CHANNEL)
  expect(removeHandler).toHaveBeenCalledWith(LOGIN_CHANNEL)
  expect(removeHandler).toHaveBeenCalledWith(RESTORE_CHANNEL)
  expect(removeHandler).toHaveBeenCalledWith(PLAN_CHANNEL)
})
