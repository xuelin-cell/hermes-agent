import { EventEmitter } from 'node:events'

import { expect, it, vi } from 'vitest'

const { handle, removeHandler, fetch } = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn(), fetch: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle, removeHandler }, net: { fetch } }))

import { CAPTCHA_CHANNEL } from './contract'
import { installCaptchaIpc } from './ipc'

it('只接受绑定窗口主框架的固定登录页与无参数请求，关闭后注销', async () => {
  const frame = { url: 'file:///test/login.html' }
  const contents = { mainFrame: frame }
  const window = Object.assign(new EventEmitter(), { isDestroyed: (): boolean => false, webContents: contents })
  installCaptchaIpc(window as never, frame.url)
  const handler = handle.mock.calls[0][1]
  const event = { sender: contents, senderFrame: frame }

  for (const invalid of [
    { ...event, sender: {} },
    { ...event, senderFrame: { url: frame.url } }
  ]) {
    expect(await handler(invalid)).toEqual({ ok: false })
  }

  expect(await handler(event, 'https://attacker.invalid')).toEqual({ ok: false })
  frame.url = 'file:///test/other.html'
  expect(await handler(event)).toEqual({ ok: false })
  expect(fetch).not.toHaveBeenCalled()
  frame.url = 'file:///test/login.html'
  fetch.mockResolvedValue(Response.json({ code: 0, data: { captchaId: 'id', b64s: 'data:image/png;base64,aGVsbG8=' } }))
  expect((await handler(event)).ok).toBe(true)
  window.isDestroyed = () => true
  expect(await handler(event)).toEqual({ ok: false })
  expect(fetch).toHaveBeenCalledTimes(1)
  window.emit('closed')
  expect(removeHandler).toHaveBeenCalledWith(CAPTCHA_CHANNEL)
})
