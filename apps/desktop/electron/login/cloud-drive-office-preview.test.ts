import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

import { OFFICE_EXTENSIONS } from '../../../shared/src/office-preview'
import { resolveReadableFileForIpc } from '../hardening'

const { handle, fromWebContents } = vi.hoisted(() => ({ handle: vi.fn(), fromWebContents: vi.fn() }))
vi.mock('electron', () => ({
  app: { once: vi.fn() },
  ipcMain: { handle },
  BrowserWindow: { fromWebContents },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }
}))

import { CloudDriveClient } from './cloud-drive'
import { installCloudDriveTransferIpc } from './cloud-drive-transfer-ipc'
import { CloudDriveTransfers } from './cloud-drive-transfers'

it('真实云盘 HTTP 与 IPC 为所有 Office 格式准备原文件，账号 A→B→A 不串文件并按窗口清理', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hermes-cloud-original-'))
  let bytes = Buffer.from('original')

  const server = createServer((req, res) => {
    const route = new URL(req.url!, 'http://fixture').pathname

    if (route.endsWith('/drive/content')) {
      res.writeHead(200, { 'Content-Length': bytes.length })
      res.end(bytes)

      return
    }

    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify(
        route.endsWith('/access-token')
          ? { meta: { code: '' }, result: { accessToken: 'private-drive' } }
          : route.endsWith('/unicom/FileDetails')
            ? { ok: true, data: { fid: 'file-one' } }
            : { ok: true, data: { download_path: '/drive/content?fid=file-one' } }
      )
    )
  })

  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const request: typeof fetch = (url, options) => {
      const source = new URL(String(url))

      return fetch(origin + source.pathname + source.search, options)
    }

    for (const account of ['account-a', 'account-b', 'account-a']) {
      const cache = path.join(root, account, 'preview')
      const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: vi.fn() })
      const event = { sender }
      fromWebContents.mockReturnValue({ webContents: sender })

      const transfers = installCloudDriveTransferIpc(
        new CloudDriveClient(
          () => ({
            uid: account,
            token: 'private-login',
            phone: '13800000000',
            maskedPhone: '138****0000',
            expiresAt: Date.now() + 60_000
          }),
          request
        ),
        cache,
        candidate => (candidate as unknown) === event
      )

      const invoke = handle.mock.calls.findLast(([channel]) => channel === 'hermes:maas-drive:transfer')![1]

      for (const extension of Object.values(OFFICE_EXTENSIONS).flat()) {
        bytes = Buffer.from(account + '-' + extension)

        const result = await invoke(event, {
          id: 'office-preview',
          operation: 'preview',
          assetId: 'same-asset',
          name: '中文.' + extension,
          size: bytes.length
        })

        expect(result).toMatchObject({ status: 'succeeded', name: '中文.' + extension, preview: { kind: 'file' } })
        const original = await resolveReadableFileForIpc(result.preview.path, { purpose: 'Preview file' })
        expect(path.extname(original.resolvedPath)).toBe('.' + extension)
        expect((await readFile(original.resolvedPath)).equals(bytes)).toBe(true)
        expect(original.resolvedPath.startsWith(cache + path.sep)).toBe(true)
        expect(JSON.stringify(result)).not.toMatch(/private-login|private-drive|data:application\/pdf/)
      }

      // 另一个窗口的结果不能被本窗口关闭删除。
      const second = await transfers.run(
        2,
        { id: 'second-window', operation: 'preview', assetId: 'same-asset', name: 'second.xlsx', size: bytes.length },
        { selectUpload: async () => null, selectDownload: async () => null, progress: () => {} }
      )

      sender.emit('destroyed')
      await transfers.clearPreviews(1)

      if (second.status !== 'succeeded' || !second.preview) {
        throw new Error('Missing second preview')
      }

      expect(await readFile(second.preview.path)).toEqual(bytes)
      await transfers.clearPreviews(2)
      expect(await readdir(cache)).toEqual([])
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
    vi.clearAllMocks()
  }
})

it('下次进程清理意外退出的专用缓存，下载失败不保留半成品', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hermes-cloud-original-stale-'))
  await writeFile(path.join(root, 'stale.docx'), 'stale private bytes')

  const drive = {
    guardIdentity: () => () => {},
    downloadContent: async () => new Response('no', { status: 500 })
  } as unknown as CloudDriveClient

  const transfers = new CloudDriveTransfers(drive, root)

  try {
    expect(
      await transfers.run(
        1,
        { id: 'failed-preview', operation: 'preview', assetId: 'asset', name: 'report.xlsx' },
        { selectUpload: async () => null, selectDownload: async () => null, progress: () => {} }
      )
    ).toMatchObject({ status: 'failed' })
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
