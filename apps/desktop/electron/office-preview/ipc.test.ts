import { expect, it, vi } from 'vitest'

const { handle, fromWebContents } = vi.hoisted(() => ({ handle: vi.fn(), fromWebContents: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle }, BrowserWindow: { fromWebContents } }))

import { installOfficePreviewIpc } from './ipc'

it('只允许固定账号桌面主框架调用，拒绝页面、分区、额外参数和账号路径伪造', async () => {
  const session = {}
  const frame = { url: 'file:///desktop/index.html?peer=1#/chat' }
  const sender = { mainFrame: frame, session }
  const window = { isDestroyed: () => false, webContents: sender }
  fromWebContents.mockReturnValue(window)
  const service = { convert: vi.fn(async () => ({ ok: false as const, code: 'unavailable' as const })) }
  let active = true
  installOfficePreviewIpc(
    session as never,
    () => 'file:///desktop/index.html',
    () => active,
    service
  )
  const invoke = handle.mock.calls.at(-1)![1]
  const event = { sender, senderFrame: frame }
  await invoke(event, 'C:\\test.docx')
  expect(service.convert).toHaveBeenCalledTimes(1)
  service.convert.mockClear()

  for (const args of [[], [''], [{}], ['source.docx', { account: 'B' }]]) {
    await invoke(event, ...args)
  }

  await invoke({ ...event, senderFrame: { ...frame } }, 'source.docx')
  sender.session = {}
  await invoke(event, 'source.docx')
  sender.session = session
  frame.url = 'https://evil.invalid/'
  await invoke(event, 'source.docx')
  frame.url = 'file:///desktop/login.html'
  await invoke(event, 'source.docx')
  frame.url = 'file:///desktop/index.html'
  active = false
  await invoke(event, 'source.docx')
  expect(service.convert).not.toHaveBeenCalled()
})

it('等待期间退出账号或页面跳转后，不向旧页面返回 PDF', async () => {
  const session = {}
  const frame = { url: 'file:///desktop/index.html' }
  const sender = { mainFrame: frame, session }
  fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  let active = true

  const service = {
    convert: vi.fn(async () => {
      active = false

      return { ok: true as const, pdf: new Uint8Array([1]), version: 'private', converter: 'wps' as const }
    })
  }

  installOfficePreviewIpc(
    session as never,
    () => frame.url,
    () => active,
    service
  )
  const invoke = handle.mock.calls.at(-1)![1]
  expect(await invoke({ sender, senderFrame: frame }, 'source.docx')).toEqual({ ok: false, code: 'unavailable' })
})
