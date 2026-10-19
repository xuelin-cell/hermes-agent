import { expect, it, vi } from 'vitest'

const { handle, fromWebContents } = vi.hoisted(() => ({ handle: vi.fn(), fromWebContents: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle }, BrowserWindow: { fromWebContents } }))

import { installOfficePreviewIpc } from './ipc'

/** 取最近一次注册的指定通道处理函数；同一次安装会注册转换和取消两个通道。 */
function handler(channel: string) {
  return handle.mock.calls.filter(call => call[0] === channel).at(-1)![1]
}

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
  const invoke = handler('hermes:office-preview:convert')
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
  // 能找到所属窗口、但不是窗口自己的页面（例如嵌入内容）也不行。
  fromWebContents.mockReturnValue({ ...window, webContents: {} })
  await invoke(event, 'source.docx')
  fromWebContents.mockReturnValue(window)
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
  const invoke = handler('hermes:office-preview:convert')
  expect(await invoke({ sender, senderFrame: frame }, 'source.docx')).toEqual({ ok: false, code: 'unavailable' })
})

it('页面离开时只能取消自己发起的请求，取消信号交给转换服务', async () => {
  const session = {}
  const frame = { url: 'file:///desktop/index.html' }
  const sender = { id: 1, mainFrame: frame, session }
  const window = { isDestroyed: () => false, webContents: sender }
  fromWebContents.mockReturnValue(window)
  let signal: AbortSignal | undefined
  let finish!: () => void

  const service = {
    convert: vi.fn(async (_path: string, received?: AbortSignal) => {
      signal = received
      await new Promise<void>(resolve => (finish = resolve))

      return { ok: false as const, code: 'unavailable' as const }
    })
  }

  installOfficePreviewIpc(
    session as never,
    () => frame.url,
    () => true,
    service
  )
  const invoke = handler('hermes:office-preview:convert')
  const cancel = handler('hermes:office-preview:cancel')
  const pending = invoke({ sender, senderFrame: frame }, 'source.docx', 'request-1')
  await vi.waitFor(() => expect(service.convert).toHaveBeenCalled())

  // 另一个页面用同样的编号取消，不影响这个请求。
  const otherSender = { id: 2, mainFrame: frame, session }
  fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: otherSender })
  cancel({ sender: otherSender, senderFrame: frame }, 'request-1')
  expect(signal?.aborted).toBe(false)

  fromWebContents.mockReturnValue(window)
  cancel({ sender, senderFrame: frame }, 'request-1')
  expect(signal?.aborted).toBe(true)
  finish()
  await pending
  expect(await invoke({ sender, senderFrame: frame }, 'source.docx', '../not an id')).toEqual({
    ok: false,
    code: 'unsupported'
  })
})

it('后台准备沿用来源和参数校验，只允许 Word/PPT，且不把 PDF 字节送回卡片', async () => {
  const session = {}
  const frame = { url: 'file:///desktop/index.html' }
  const sender = { id: 1, mainFrame: frame, session }
  fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: sender })

  const service = {
    convert: vi.fn(async () => ({
      ok: true as const,
      pdf: new Uint8Array([1]),
      version: 'v',
      converter: 'wps' as const
    }))
  }

  installOfficePreviewIpc(
    session as never,
    () => frame.url,
    () => true,
    service
  )
  const invoke = handler('hermes:office-preview:convert')
  const event = { sender, senderFrame: frame }
  expect(await invoke(event, 'report.pptx', 'prepare-1', 'background')).toBeUndefined()
  expect(service.convert).toHaveBeenCalledWith(expect.any(String), expect.any(AbortSignal), true)
  service.convert.mockClear()

  for (const args of [
    ['report.xlsx', 'p', 'background'],
    ['r.docx', 'p', 'foreground'],
    ['r.docx', 'p', {}],
    ['r.docx', '../p', 'background']
  ]) {
    expect(await invoke(event, ...args)).toEqual({ ok: false, code: 'unsupported' })
  }

  expect(await invoke({ ...event, senderFrame: { ...frame } }, 'r.docx', 'p', 'background')).toEqual({
    ok: false,
    code: 'unsupported'
  })
  expect(service.convert).not.toHaveBeenCalled()
})
