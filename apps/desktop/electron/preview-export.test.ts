import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { strFromU8, unzipSync } from 'fflate'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  save: vi.fn(),
  print: vi.fn(),
  load: vi.fn(),
  destroy: vi.fn(),
  created: vi.fn(),
  requests: vi.fn(),
  clear: vi.fn(),
  parent: null as unknown
}))

vi.mock('electron', () => {
  /** 只替代系统打印窗；来源校验、归档和实际文件写入走产品代码。 */
  function Window(options: unknown) {
    mock.created(options)

    return {
      webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn(), printToPDF: mock.print },
      loadURL: mock.load,
      destroy: mock.destroy
    }
  }

  Window.fromWebContents = () => mock.parent

  return {
    BrowserWindow: Window,
    dialog: { showSaveDialog: mock.save },
    ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mock.handlers.set(name, handler) },
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler: vi.fn(),
        webRequest: { onBeforeRequest: mock.requests },
        clearStorageData: mock.clear
      })
    }
  }
})

import { wordDocument } from '../../shared/src/preview-export'

import { installPreviewExportIpc, previewPdf } from './preview-export'

let root: string
const accountSession = {}
const frame = { url: 'file:///desktop/index.html' }
const sender = { mainFrame: frame, session: accountSession }
const event = { sender, senderFrame: frame }
let active = true

beforeEach(async () => {
  vi.clearAllMocks()
  mock.handlers.clear()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-export-unit-'))
  mock.parent = { isDestroyed: () => false, webContents: sender }
  mock.load.mockResolvedValue(undefined)
  mock.print.mockResolvedValue(Buffer.from('%PDF-1.7\nexport'))
  mock.clear.mockResolvedValue(undefined)
  active = true
  installPreviewExportIpc(
    accountSession as never,
    () => frame.url,
    () => active
  )
})
afterEach(async () => {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('hermes-export-unit-')) {
    throw new Error('Unsafe cleanup')
  }

  await fs.rm(root, { recursive: true, force: true })
})

it('Word 是可解压 OOXML，中文正文和内嵌图片保存在 MHT，而不是假后缀 HTML', () => {
  const files = unzipSync(wordDocument('<h1>中文标题</h1><img src="data:image/png;base64,aGVsbG8=">'))
  expect(strFromU8(files['word/document.xml'])).toContain('<w:altChunk r:id="html"/>')
  expect(strFromU8(files['word/_rels/document.xml.rels'])).toContain('Target="afchunk.mht"')
  const mht = strFromU8(files['word/afchunk.mht'])
  expect(mht).toContain('Content-Type: image/png')
  expect(mht).toContain('aGVsbG8=')
  const base64 = mht.split('Content-Location: file:///preview/document.html\r\n\r\n')[1].split('\r\n--')[0]
  expect(Buffer.from(base64, 'base64').toString()).toContain('<h1>中文标题</h1>')
})

it.each(['md', 'pdf', 'docx'])('保存 %s 使用原生选择的路径，原文或格式字节实际写入', async format => {
  const file = path.join(root, `chosen.${format}`)
  mock.save.mockResolvedValue({ canceled: false, filePath: file })

  const result = await mock.handlers.get('hermes:preview:export')!(event, {
    format,
    name: '../报告.md',
    content: '# 完整原文\n'
  })

  expect(result).toEqual({ status: 'saved' })
  expect(mock.save.mock.calls[0][1].defaultPath).toBe(`报告.${format}`)
  const bytes = await fs.readFile(file)

  if (format === 'md') {
    expect(bytes.toString()).toBe('# 完整原文\n')
  }

  if (format === 'pdf') {
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    expect(mock.print).toHaveBeenCalledWith(expect.objectContaining({ preferCSSPageSize: true, printBackground: true }))
  }

  if (format === 'docx') {
    expect(unzipSync(bytes)['word/document.xml']).toBeTruthy()
  }
})

it('取消不写文件；非法来源、格式和超限内容不打开保存框', async () => {
  const invoke = mock.handlers.get('hermes:preview:export')!
  const input = { format: 'md', name: 'note.md', content: 'keep' }
  mock.save.mockResolvedValue({ canceled: true })
  expect(await invoke(event, input)).toEqual({ status: 'cancelled' })
  mock.save.mockClear()

  for (const payload of [null, { ...input, format: 'exe' }, { ...input, content: 'x'.repeat(8 * 1024 * 1024 + 1) }]) {
    expect(await invoke(event, payload)).toEqual({ status: 'failed' })
  }

  expect(await invoke({ ...event, senderFrame: { ...frame } }, input)).toEqual({ status: 'failed' })
  active = false
  expect(await invoke(event, input)).toEqual({ status: 'failed' })
  expect(mock.save).not.toHaveBeenCalled()
})

it('保存框返回时账号已退出，不再转换或覆盖目标文件', async () => {
  const file = path.join(root, 'keep.pdf')
  await fs.writeFile(file, 'original')
  mock.save.mockImplementation(async () => {
    active = false

    return { canceled: false, filePath: file }
  })
  expect(
    await mock.handlers.get('hermes:preview:export')!(event, { format: 'pdf', name: 'note.md', content: '<p>x</p>' })
  ).toEqual({ status: 'failed' })
  expect(mock.print).not.toHaveBeenCalled()
  expect(await fs.readFile(file, 'utf8')).toBe('original')
})

it('PDF 使用禁脚本隔离窗，拒绝网络和本机资源，打印失败也销毁并清理', async () => {
  let temporaryFile = ''
  mock.load.mockImplementation(async url => {
    temporaryFile = fileURLToPath(url)
    expect(await fs.readFile(temporaryFile, 'utf8')).toContain('Content-Security-Policy')
    const callback = vi.fn()
    const requests = mock.requests.mock.calls[0][0]
    requests({ url, resourceType: 'mainFrame' }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: false })
    requests({ url, resourceType: 'image' }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
  })
  mock.print.mockRejectedValueOnce(new Error('print failure'))
  await expect(previewPdf('<script>bad()</script>')).rejects.toThrow('print failure')
  expect(mock.created.mock.calls[0][0]).toMatchObject({
    show: false,
    webPreferences: { javascript: false, nodeIntegration: false, sandbox: true }
  })
  expect(mock.created.mock.calls[0][0].webPreferences.preload).toBeUndefined()
  const callback = vi.fn()

  for (const url of ['https://example.com/secret', 'file:///C:/secret']) {
    mock.requests.mock.calls[0][0]({ url }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
  }

  expect(mock.destroy).toHaveBeenCalledOnce()
  expect(mock.clear).toHaveBeenCalledOnce()
  await expect(fs.stat(temporaryFile)).rejects.toMatchObject({ code: 'ENOENT' })
})
