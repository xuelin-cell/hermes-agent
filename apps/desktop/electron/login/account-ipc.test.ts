import { expect, it, vi } from 'vitest'

const { handle, fromWebContents, netFetch } = vi.hoisted(() => ({
  handle: vi.fn(),
  fromWebContents: vi.fn(),
  netFetch: vi.fn()
}))
vi.mock('electron', () => ({
  app: { once: vi.fn() },
  ipcMain: { handle },
  BrowserWindow: { fromWebContents },
  net: { fetch: netFetch }
}))

import { installAccountIpc } from './account-ipc'

// 下载工具可用性同样绑定账号主框架，页面只读取布尔值。
it('云盘 MCP 可用性拒绝其他来源和额外身份参数', () => {
  const partition = {}
  const frame = { url: 'http://127.0.0.1:5174/#/artifacts' }
  const sender = { mainFrame: frame, session: partition }
  const identity = { uid: 'a', token: 'private', phone: '13800000000', maskedPhone: '138****0000', expiresAt: Date.now() + 60_000 }
  const ready = vi.fn((profile: string) => profile === 'work')
  fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  installAccountIpc(partition as never, () => 'http://127.0.0.1:5174', () => identity, undefined, () => identity, undefined, undefined, undefined, ready)
  const invoke = handle.mock.calls.findLast(call => call[0] === 'hermes:maas-drive:agent-ready')![1]
  const event = { sender, senderFrame: frame }
  expect(invoke({ sender, senderFrame: {} }, 'work')).toBe(false)
  expect(invoke(event, 'work', 'forged-identity')).toBe(false)
  expect(ready).not.toHaveBeenCalled()
  expect(invoke(event, 'work')).toBe(true)
  expect(invoke(event, 'unknown')).toBe(false)
  expect(ready.mock.calls).toEqual([['work'], ['unknown']])
})

it('主副窗只读取已准备账号的展示字段，到期保留退出入口，撤销后不显示旧账号', async () => {
  const identity = {
    uid: 'private-uid',
    token: 'private-token',
    maskedPhone: '138****0000',
    expiresAt: Date.now() + 60_000
  }

  const readAccount = vi.fn().mockReturnValue(null)
  const logout = vi.fn(async () => {})
  const partition = {}
  const frame = { url: 'http://127.0.0.1:5174/?peer=1#/chat' }
  const sender = { mainFrame: frame, session: partition }
  fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  installAccountIpc(partition as never, () => 'http://127.0.0.1:5174', readAccount, logout)
  const read = handle.mock.calls.at(-1)![1]
  const event = { sender, senderFrame: frame }
  expect(read(event)).toBeNull()
  readAccount.mockReturnValue(identity)
  expect(read(event)).toEqual({ maskedPhone: identity.maskedPhone, expiresAt: identity.expiresAt })
  frame.url = 'http://127.0.0.1:5174/#/'
  expect(read(event)).toEqual({ maskedPhone: identity.maskedPhone, expiresAt: identity.expiresAt })
  vi.spyOn(Date, 'now').mockReturnValue(identity.expiresAt)
  expect(read(event)).toEqual({ maskedPhone: identity.maskedPhone, expiresAt: identity.expiresAt })
  const invoke = handle.mock.calls.findLast(call => call[0] === 'hermes:maas-account:logout')![1]
  await invoke(event)
  expect(logout).toHaveBeenCalledTimes(1)
  vi.restoreAllMocks()
  readAccount.mockReturnValue(null)
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
// 云盘不接受其他账号分区、子框架或页面提供的凭据。
it('云盘只允许当前桌面主框架调用，不接受额外身份参数', async () => {
  const identity = {
    uid: 'a',
    token: 'private',
    phone: '13800000000',
    maskedPhone: '138****0000',
    expiresAt: Date.now() + 60_000
  }

  const partition = {}
  const frame = { url: 'http://127.0.0.1:5174/#/artifacts' }
  const sender = { mainFrame: frame, session: partition }
  fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  installAccountIpc(
    partition as never,
    () => 'http://127.0.0.1:5174',
    () => identity,
    undefined,
    () => identity
  )
  const invoke = handle.mock.calls.findLast(call => call[0] === 'hermes:maas-drive:request')![1]
  await expect(invoke({ sender, senderFrame: {} }, { route: '/asset-spaces' })).rejects.toThrow('无效')
  await expect(invoke({ sender, senderFrame: frame }, { route: '/asset-spaces' }, 'forged-token')).rejects.toThrow(
    '无效'
  )
  frame.url = 'https://untrusted.example/'
  await expect(invoke({ sender, senderFrame: frame }, { route: '/asset-spaces' })).rejects.toThrow('无效')
})

it('实时识别拒绝子框架、其他分区和额外凭据，只读取主进程身份', async () => {
  const partition = {}
  const frame = { url: 'http://127.0.0.1:5174/#/chat' }
  const sender = { mainFrame: frame, session: partition }
  fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  const identity = vi.fn(() => null)
  installAccountIpc(
    partition as never,
    () => 'http://127.0.0.1:5174',
    () => null,
    undefined,
    undefined,
    identity
  )
  const invoke = handle.mock.calls.findLast(call => call[0] === 'hermes:uniwork-asr')![1]
  const request = { operation: 'start', language: 'zh' }
  await expect(invoke({ sender, senderFrame: {} }, request)).rejects.toThrow('请求无效')
  await expect(invoke({ sender, senderFrame: frame }, request, 'forged-key')).rejects.toThrow('请求无效')
  sender.session = {}
  await expect(invoke({ sender, senderFrame: frame }, request)).rejects.toThrow('请求无效')
  sender.session = partition
  frame.url = 'https://untrusted.example/'
  await expect(invoke({ sender, senderFrame: frame }, request)).rejects.toThrow('请求无效')
  expect(identity).not.toHaveBeenCalled()
  frame.url = 'http://127.0.0.1:5174/'
  await expect(invoke({ sender, senderFrame: frame }, request)).rejects.toThrow('需要有效的元景套餐')
  expect(identity).toHaveBeenCalledOnce()
})


it('办公目录仅允许当前桌面主框架选择固定语言，不接受地址或身份参数', async () => {
  const partition = {}
  const frame = { url: 'http://127.0.0.1:5174/#/chat' }
  const sender = { mainFrame: frame, session: partition }
  fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  const identity = vi.fn(() => null)
  installAccountIpc(partition as never, () => 'http://127.0.0.1:5174', () => null,
    undefined, identity)
  const usage = handle.mock.calls.findLast(call => call[0] === 'hermes:maas-account:usage')![1]
  expect(usage({ sender, senderFrame: {} })).toEqual({ status: 'failed' })
  expect(usage({ sender, senderFrame: frame }, 'forged-token')).toEqual({ status: 'failed' })
  sender.session = {}
  expect(usage({ sender, senderFrame: frame })).toEqual({ status: 'failed' })
  sender.session = partition
  expect(identity).not.toHaveBeenCalled()
  expect(await usage({ sender, senderFrame: frame })).toEqual({ status: 'failed', reason: 'auth' })
  identity.mockClear()
  const invoke = handle.mock.calls.findLast(call => call[0] === 'hermes:uniwork-welcome:catalog')![1]
  await expect(invoke({ sender, senderFrame: {} }, 'zh-CN')).rejects.toThrow('请求无效')
  await expect(invoke({ sender, senderFrame: frame }, 'zh-CN', 'forged-key')).rejects.toThrow('请求无效')
  await expect(invoke({ sender, senderFrame: frame }, 'https://untrusted.example/')).rejects.toThrow('请求无效')
  expect(identity).not.toHaveBeenCalled()
  await expect(invoke({ sender, senderFrame: frame }, 'zh-CN')).rejects.toThrow('更新失败')
})

it('语音身份保持第六个参数，办公模板和云盘传输在同一次安装中同时可用', async () => {
  const partition = {}
  const frame = { url: 'http://127.0.0.1:5174/#/chat' }
  const sender = { id: 3, mainFrame: frame, session: partition }
  const account = { uid: 'a', token: 'private', phone: '13800000000', maskedPhone: '138****0000', expiresAt: Date.now() + 60_000 }
  let active = true
  // 在同一安装实例中模拟登录失效，核对模板和云盘共用账号但不混入语音身份。
  const readIdentity = () => active ? account : null
  const readAsrIdentity = vi.fn(() => null)
  const ready = vi.fn((profile: string) => profile === 'work')
  const start = handle.mock.calls.length
  fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  installAccountIpc(partition as never, () => 'http://127.0.0.1:5174', () => account,
    undefined, readIdentity, readAsrIdentity, '/unused/cloud-preview', undefined, ready)
  const handlers = new Map(handle.mock.calls.slice(start).map(([channel, invoke]) => [channel, invoke]))
  const event = { sender, senderFrame: frame }
  expect(handlers.get('hermes:maas-drive:agent-ready')!(event, 'work')).toBe(true)
  expect(ready).toHaveBeenCalledWith('work')
  await expect(handlers.get('hermes:uniwork-asr')!(event, { operation: 'start', language: 'zh' })).rejects.toThrow('需要有效的元景套餐')
  expect(readAsrIdentity).toHaveBeenCalledOnce()
  await expect(handlers.get('hermes:maas-drive:transfer')!({ sender, senderFrame: {} }, {})).rejects.toThrow('请求无效')
  active = false
  await expect(handlers.get('hermes:uniwork-welcome:catalog')!(event, 'zh-CN')).rejects.toThrow('更新失败')
})

it('订阅只读取主进程身份，拒绝额外参数并在主进程拼接市场地址', async () => {
  const partition = {}
  const frame = { url: 'http://127.0.0.1:5174/#/chat' }
  const sender = { mainFrame: frame, session: partition }
  fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  const identity: {
    uid: string
    token: string
    phone?: string
    maskedPhone: string
    expiresAt: number
  } = {
    uid: 'a',
    token: 'secret-token',
    phone: '13800000000',
    maskedPhone: '138****0000',
    expiresAt: Date.now() + 60_000
  }
  const openExternal = vi.fn(async (_url: string) => ({ ok: true }))
  netFetch.mockReset()
  netFetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        ticket: 'ticket-1',
        customerId: 'customer-1',
        timestamp: '1700000000',
        number: 'order-1'
      }),
      { status: 200 }
    )
  )
  installAccountIpc(
    partition as never,
    () => 'http://127.0.0.1:5174/#/chat',
    () => identity,
    undefined,
    () => identity,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    openExternal
  )
  const invoke = handle.mock.calls.findLast(call => call[0] === 'hermes:maas-account:subscribe')![1]
  const event = { sender, senderFrame: frame }
  expect(await invoke({ sender, senderFrame: {} }, 'forged')).toEqual({ status: 'failed' })
  sender.session = {}
  expect(await invoke(event)).toEqual({ status: 'failed' })
  sender.session = partition
  frame.url = 'https://untrusted.example/'
  expect(await invoke(event)).toEqual({ status: 'failed' })
  expect(netFetch).not.toHaveBeenCalled()
  expect(openExternal).not.toHaveBeenCalled()

  frame.url = 'http://127.0.0.1:5174/#/chat'
  expect(await invoke(event)).toEqual({ status: 'opened' })
  expect(netFetch).toHaveBeenCalledTimes(1)
  expect(netFetch).toHaveBeenCalledWith(
    'https://maas.ai-yuanjing.com/app/gateway/uniwork/market-ticket',
    expect.objectContaining({ headers: { Accept: 'application/json', Authorization: 'Bearer secret-token' } })
  )
  expect(openExternal).toHaveBeenCalledTimes(1)
  const url = openExternal.mock.calls[0]![0] as string
  expect(url).toContain('ticket=ticket-1')
  expect(url).toContain('customerid=customer-1')
  expect(url).toContain('single=1')
  expect(url).not.toContain('secret-token')
  expect(url).not.toContain('13800000000')

  identity.phone = undefined
  expect(await invoke(event)).toEqual({ status: 'failed', reason: 'missing-phone' })
  expect(netFetch).toHaveBeenCalledTimes(1)
  expect(openExternal).toHaveBeenCalledTimes(1)
})
