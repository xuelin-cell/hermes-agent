import { expect, it, vi } from 'vitest'

const { handle, fromWebContents } = vi.hoisted(() => ({ handle: vi.fn(), fromWebContents: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle }, BrowserWindow: { fromWebContents } }))

import { installAccountIpc } from './account-ipc'
import { LoginSession } from './session'

it('主窗和副窗只读取同一有效身份的展示字段，未登录或到期不返回旧账号', () => {
  const identity = {
    uid: 'private-uid',
    token: 'private-token',
    maskedPhone: '138****0000',
    expiresAt: Date.now() + 60_000
  }

  const session = new LoginSession(vi.fn(), { save: vi.fn(), load: () => identity as never })
  const partition = {}
  const frame = { url: 'http://127.0.0.1:5174/?peer=1#/chat' }
  const sender = { mainFrame: frame, session: partition }
  fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  installAccountIpc(
    partition as never,
    () => 'http://127.0.0.1:5174',
    () => session.currentIdentity()
  )
  const read = handle.mock.calls.at(-1)![1]
  const event = { sender, senderFrame: frame }
  expect(read(event)).toBeNull()
  session.restore()
  expect(read(event)).toEqual({ maskedPhone: identity.maskedPhone, expiresAt: identity.expiresAt })
  frame.url = 'http://127.0.0.1:5174/#/'
  expect(read(event)).toEqual({ maskedPhone: identity.maskedPhone, expiresAt: identity.expiresAt })
  vi.spyOn(Date, 'now').mockReturnValue(identity.expiresAt)
  expect(read(event)).toBeNull()
  vi.restoreAllMocks()
  session.dispose()
  expect(read(event)).toBeNull()
})

it('拒绝额外参数、非桌面窗口、子框架、其他账号分区和其他页面', () => {
  const partition = {}
  const frame = { url: 'file:///desktop/index.html?peer=1#/' }
  const sender = { mainFrame: frame, session: partition }
  const window = { isDestroyed: () => false, webContents: sender }
  const readAccount = vi.fn(() => ({ maskedPhone: '139****0000', expiresAt: Date.now() + 60_000 }))
  fromWebContents.mockReturnValue(window)
  installAccountIpc(partition as never, () => 'file:///desktop/index.html', readAccount)
  const read = handle.mock.calls.at(-1)![1]
  const event = { sender, senderFrame: frame }
  expect(read(event, { uid: 'forged' })).toBeNull()
  expect(read({ ...event, senderFrame: { ...frame } })).toBeNull()
  sender.session = {}
  expect(read(event)).toBeNull()
  sender.session = partition

  for (const url of ['file:///desktop/login.html', 'https://other.invalid/index.html', 'invalid']) {
    frame.url = url
    expect(read(event)).toBeNull()
  }

  frame.url = 'file:///desktop/index.html'
  fromWebContents.mockReturnValue(null)
  expect(read(event)).toBeNull()
  fromWebContents.mockReturnValue({ ...window, isDestroyed: () => true })
  expect(read(event)).toBeNull()
  expect(readAccount).not.toHaveBeenCalled()
})

it('退出 IPC 同样验证主框架与账号，不接受页面指定身份或目录', async () => {
  const partition = {}
  const frame = { url: 'file:///desktop/index.html' }
  const sender = { mainFrame: frame, session: partition }
  fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  const account = vi.fn(() => ({ maskedPhone: '138****0000', expiresAt: Date.now() + 60_000 }))
  const logout = vi.fn(async () => {})
  installAccountIpc(partition as never, () => frame.url, account, logout)
  const invoke = handle.mock.calls.findLast(call => call[0] === 'hermes:maas-account:logout')![1]
  const event = { sender, senderFrame: frame }
  await expect(invoke(event, { uid: 'other' })).rejects.toThrow()
  await expect(invoke({ ...event, senderFrame: {} })).rejects.toThrow()
  expect(logout).not.toHaveBeenCalled()
  await invoke(event)
  expect(logout).toHaveBeenCalledWith()
  account.mockReturnValueOnce(null as never)
  await expect(invoke(event)).rejects.toThrow()
  expect(logout).toHaveBeenCalledTimes(1)
})
