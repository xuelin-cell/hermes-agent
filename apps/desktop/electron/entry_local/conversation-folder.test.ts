import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
const windows = vi.hoisted(() => new Map<unknown, { isDestroyed: () => boolean; webContents: unknown }>())

vi.mock('electron', () => ({
  // 来源校验走产品代码；窗口查找只认测试里登记的桌面窗口。
  BrowserWindow: { fromWebContents: (sender: unknown) => windows.get(sender) ?? null },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) }
}))

import { conversationFolderName, createConversationFolders, installConversationFolderIpc } from './conversation-folder'

const NOW = new Date(2026, 9, 19, 10, 30, 15)
const NAME = '20261019-103015'

let root: string
let workspace: string

beforeEach(async () => {
  handlers.clear()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-conv-folder-'))
  workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
})

afterEach(async () => {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('hermes-conv-folder-')) {
    throw new Error('Unsafe cleanup')
  }

  await fs.rm(root, { recursive: true, force: true })
})

describe('主进程建对话文件夹', () => {
  it('名字是本地时间 YYYYMMDD-HHmmss', () => {
    expect(conversationFolderName(NOW)).toBe(NAME)
    expect(conversationFolderName(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405')
  })

  it('在账号工作区下建文件夹；同一秒重名依次加 -2、-3，不复用已有文件夹', async () => {
    const folders = createConversationFolders(workspace, () => NOW)
    await fs.mkdir(path.join(workspace, `${NAME}-2`))

    expect(await folders.create(workspace)).toBe(path.join(workspace, NAME))
    expect(await folders.create(workspace)).toBe(path.join(workspace, `${NAME}-3`))
    expect((await fs.readdir(workspace)).sort()).toEqual([NAME, `${NAME}-2`, `${NAME}-3`])
  })

  it('页面查到的默认目录按 Windows 规则比较大小写和分隔符', async () => {
    const folders = createConversationFolders(workspace, () => NOW)
    const variant = process.platform === 'win32' ? `${workspace.toUpperCase()}\\` : `${workspace}/`

    expect(await folders.create(variant)).toBe(path.join(workspace, NAME))
  })

  it('默认目录不是账号工作区（专家自带目录、空值、上一级）时不建', async () => {
    const folders = createConversationFolders(workspace, () => NOW)

    for (const other of [path.join(root, 'expert'), '', '  ', root, path.join(workspace, 'sub')]) {
      expect(await folders.create(other)).toBeNull()
    }

    expect(await fs.readdir(workspace)).toEqual([])
  })

  it('账号工作区是目录联接或不存在时不建', async () => {
    const real = path.join(root, 'elsewhere')
    const link = path.join(root, 'linked')
    await fs.mkdir(real)
    await fs.symlink(real, link, 'junction')

    expect(await createConversationFolders(link, () => NOW).create(link)).toBeNull()
    expect(await fs.readdir(real)).toEqual([])
    expect(
      await createConversationFolders(path.join(root, 'missing'), () => NOW).create(path.join(root, 'missing'))
    ).toBeNull()
  })

  it('只删除本进程建的、仍为空的文件夹', async () => {
    const folders = createConversationFolders(workspace, () => NOW)
    const empty = (await folders.create(workspace))!
    const used = (await folders.create(workspace))!
    const foreign = path.join(workspace, 'user-folder')
    await fs.writeFile(path.join(used, 'a.txt'), 'x')
    await fs.mkdir(foreign)

    await folders.discard(empty)
    await folders.discard(used)
    await folders.discard(foreign)
    await folders.discard(workspace)

    expect((await fs.readdir(workspace)).sort()).toEqual([`${NAME}-2`, 'user-folder'])
  })
})

describe('对话文件夹 IPC', () => {
  const accountSession = {}
  const frame = { url: 'file:///desktop/index.html' }
  const trustedEvent = { sender: { mainFrame: frame, session: accountSession }, senderFrame: frame }
  const foreignFrame = { url: 'https://example.com/' }
  const foreignEvent = { sender: { mainFrame: foreignFrame, session: accountSession }, senderFrame: foreignFrame }
  let active = true

  beforeEach(() => {
    active = true
    windows.clear()

    for (const event of [trustedEvent, foreignEvent]) {
      windows.set(event.sender, { isDestroyed: () => false, webContents: event.sender })
    }

    installConversationFolderIpc(
      accountSession as never,
      () => frame.url,
      () => active,
      createConversationFolders(workspace, () => NOW)
    )
  })

  it('当前账号桌面页面可建可删', async () => {
    const folder = await handlers.get('hermes:conversation-folder:create')!(trustedEvent, workspace)
    expect(folder).toBe(path.join(workspace, NAME))

    await handlers.get('hermes:conversation-folder:discard')!(trustedEvent, folder)
    expect(await fs.readdir(workspace)).toEqual([])
  })

  it('非桌面来源、账号已不活动或参数异常时什么都不做', async () => {
    const create = handlers.get('hermes:conversation-folder:create')!

    expect(await create(foreignEvent, workspace)).toBeNull()
    expect(await create(trustedEvent, 42)).toBeNull()
    expect(await create(trustedEvent, 'x'.repeat(4097))).toBeNull()
    active = false
    expect(await create(trustedEvent, workspace)).toBeNull()
    expect(await fs.readdir(workspace)).toEqual([])

    active = true
    const folder = await create(trustedEvent, workspace)
    await handlers.get('hermes:conversation-folder:discard')!(foreignEvent, folder)
    expect(await fs.readdir(workspace)).toEqual([NAME])
  })
})
