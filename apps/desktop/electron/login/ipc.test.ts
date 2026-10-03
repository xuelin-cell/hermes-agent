import { EventEmitter } from 'node:events'

import { expect, it, vi } from 'vitest'

const { handle, removeHandler, fetch } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn(), fetch: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle, removeHandler }, net: { fetch } }))

import { CAPTCHA_CHANNEL, SEND_SMS_CHANNEL } from './contract'
import { installLoginIpc } from './ipc'

it('只接受绑定窗口主框架的固定登录页与无参数请求，关闭后注销', async () => {
  const frame = { url: 'file:///test/login.html' }
  const contents = { mainFrame: frame }
  const window = Object.assign(new EventEmitter(), { isDestroyed: (): boolean => false, webContents: contents })
  installLoginIpc(window as never, frame.url)
  const handler = handle.mock.calls[0][1]
  const send = handle.mock.calls[1][1]
  const input = { phone: '13800000000', captchaCode: 'abcd', captchaId: 'id' }
  const event = { sender: contents, senderFrame: frame }

  for (const invalid of [
    { ...event, sender: {} },
    { ...event, senderFrame: { url: frame.url } }
  ]) {
    expect(await handler(invalid)).toEqual({ ok: false })
    expect(await send(invalid, input)).toEqual({ ok: false, error: 'invalid' })
  }

  expect(await handler(event, 'https://attacker.invalid')).toEqual({ ok: false })
  expect(await send(event, input, 'extra')).toEqual({ ok: false, error: 'invalid' })
  expect(await send(event)).toEqual({ ok: false, error: 'invalid' })
  frame.url = 'file:///test/other.html'
  expect(await handler(event)).toEqual({ ok: false })
  expect(await send(event, input)).toEqual({ ok: false, error: 'invalid' })
  expect(fetch).not.toHaveBeenCalled()
  frame.url = 'file:///test/login.html'
  fetch.mockResolvedValue(Response.json({ code: 0, data: { captchaId: 'id', b64s: 'data:image/png;base64,aGVsbG8=' } }))
  expect((await handler(event)).ok).toBe(true)
  fetch.mockResolvedValueOnce(Response.json({ code: 0 }))
  expect((await send(event, input)).ok).toBe(true)
  window.isDestroyed = () => true
  expect(await handler(event)).toEqual({ ok: false })
  expect(await send(event, input)).toEqual({ ok: false, error: 'invalid' })
  expect(fetch).toHaveBeenCalledTimes(2)
  window.emit('closed')
  expect(removeHandler).toHaveBeenCalledWith(CAPTCHA_CHANNEL)
  expect(removeHandler).toHaveBeenCalledWith(SEND_SMS_CHANNEL)
})
