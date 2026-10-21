import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

const { handle, fromWebContents, showOpenDialog, showSaveDialog } = vi.hoisted(() => ({
  handle: vi.fn(),
  fromWebContents: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn()
}))

vi.mock('electron', () => ({
  app: { once: vi.fn() },
  ipcMain: { handle },
  BrowserWindow: { fromWebContents },
  dialog: { showOpenDialog, showSaveDialog }
}))

import { CloudDriveClient } from './cloud-drive'
import { createDriveArtifactResolver } from './cloud-drive-artifact-source'
import { installCloudDriveTransferIpc } from './cloud-drive-transfer-ipc'

it('本地产物通过真实会话 HTTP、来源核对和 IPC 上传，Profile A→B→A 不串文件且不用文件选择框', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hermes-artifact-ipc-'))
  const profiles = ['work-a', 'work-b']
  const uploads: { name: string; directory: string; bytes: string }[] = []

  for (const profile of profiles) {
    await mkdir(path.join(root, profile))
    await writeFile(path.join(root, profile, 'report.txt'), profile)
  }

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []

    for await (const chunk of request) {
      chunks.push(chunk)
    }

    const route = new URL(request.url!, 'http://fixture')
    const profile = route.searchParams.get('profile') || 'default'
    response.setHeader('Content-Type', 'application/json')
    let payload: unknown

    if (route.pathname.startsWith('/api/sessions/')) {
      expect(request.headers.authorization).toBe('Bearer backend-only')
      payload = route.pathname.endsWith('/messages')
        ? { profile, messages: [{ role: 'assistant', content: 'MEDIA:./report.txt' }] }
        : { id: 'same-session', profile, cwd: path.join(root, profile) }
    } else if (route.pathname.endsWith('/access-token')) {
      payload = { meta: { code: '' }, result: { accessToken: 'cloud-only' } }
    } else if (route.pathname.endsWith('/assets')) {
      payload = { ok: true, data: { items: [], page: { has_more: false } } }
    } else if (route.pathname.endsWith('/drive/capabilities')) {
      payload = { ok: true, data: { upload: true } }
    } else {
      expect(request.headers.authorization).toBe('Bearer login-only')
      expect(request.headers['x-drive-access-token']).toBe('cloud-only')
      const metadata = JSON.parse(Buffer.from(String(request.headers['x-drive-upload-metadata']), 'base64').toString())
      uploads.push({
        name: metadata.fileName,
        directory: metadata.directoryId,
        bytes: Buffer.concat(chunks).toString()
      })
      payload = { ok: true, status: 'succeeded', data: {} }
    }

    response.end(JSON.stringify(payload))
  })

  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const resolver = createDriveArtifactResolver({
      workspace: root,
      connect: async () => ({ mode: 'local' }),
      read: async (_backend, route, signal) => {
        const response = await fetch(origin + route, { signal, headers: { Authorization: 'Bearer backend-only' } })

        return await response.json()
      }
    })

    const request: typeof fetch = (url, options) => fetch(origin + new URL(String(url)).pathname, options)

    const identity = {
      uid: 'account',
      token: 'login-only',
      phone: '13800000000',
      maskedPhone: '138****0000',
      expiresAt: Date.now() + 60_000
    }

    const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: vi.fn() })
    const event = { sender }
    fromWebContents.mockReturnValue({ webContents: sender })
    showOpenDialog.mockClear()
    installCloudDriveTransferIpc(
      new CloudDriveClient(() => identity, request),
      path.join(root, 'cache'),
      candidate => (candidate as unknown) === event,
      resolver
    )
    const invoke = handle.mock.calls.findLast(([channel]) => channel === 'hermes:maas-drive:transfer')![1]

    for (const profile of [profiles[0], profiles[1], profiles[0]]) {
      const result = await invoke(event, {
        id: 'artifact-upload',
        operation: 'upload',
        parentAssetId: 'folder-' + profile,
        artifact: { sessionId: 'same-session', profile, connectionId: 'local', value: './report.txt' }
      })

      expect(structuredClone(result)).toEqual({ status: 'succeeded', name: 'report.txt' })
    }

    expect(uploads).toEqual([
      { name: 'report.txt', directory: 'folder-work-a', bytes: 'work-a' },
      { name: 'report.txt', directory: 'folder-work-b', bytes: 'work-b' },
      { name: 'report.txt', directory: 'folder-work-a', bytes: 'work-a' }
    ])
    expect(showOpenDialog).not.toHaveBeenCalled()
    expect(JSON.stringify(sender.send.mock.calls)).not.toMatch(/backend-only|login-only|cloud-only/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
    vi.clearAllMocks()
  }
})

it('原生 IPC、文件选择、HTTP 分片和下载完整串通，页面拿不到本机路径或认证头', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hermes-drive-ipc-'))
  const body = Buffer.from('中文 cloud file')
  const calls: { route: string; body: Buffer; authorization?: string; drive?: string }[] = []

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []

    for await (const chunk of req) {
      chunks.push(chunk)
    }

    calls.push({
      route: req.url!,
      body: Buffer.concat(chunks),
      authorization: req.headers.authorization,
      drive: req.headers['x-drive-access-token'] as string | undefined
    })
    const route = req.url!

    if (route.endsWith('/drive/content?fid=test-fid')) {
      res.writeHead(200, { 'Content-Length': body.length })
      res.end(body)

      return
    }

    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify(
        route.endsWith('/access-token')
          ? { meta: { code: '' }, result: { accessToken: 'secret-drive' } }
          : route.endsWith('/drive/capabilities')
            ? { ok: true, data: { upload: true } }
            : route.endsWith('/drive/upload-part')
              ? { ok: true, status: 'succeeded', data: {} }
              : route.endsWith('/unicom/FileDetails')
                ? { ok: true, data: { fid: 'test-fid' } }
                : { ok: true, data: { download_path: '/drive/content?fid=test-fid' } }
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

    const client = new CloudDriveClient(
      () => ({
        uid: 'user',
        token: 'secret-login',
        phone: '13800000000',
        maskedPhone: '138****0000',
        expiresAt: Date.now() + 60_000
      }),
      request
    )

    const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: vi.fn() })
    const event = { sender }
    fromWebContents.mockReturnValue({ webContents: sender })
    installCloudDriveTransferIpc(client, path.join(root, 'cache'), candidate => (candidate as unknown) === event)
    const invoke = handle.mock.calls.findLast(([channel]) => channel === 'hermes:maas-drive:transfer')![1]
    const source = path.join(root, 'source.txt')
    const saved = path.join(root, 'saved.txt')
    await writeFile(source, body)
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [source] })
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: saved })
    const upload = await invoke(event, { id: 'upload-one', operation: 'upload', parentAssetId: 'root' })
    expect(structuredClone(upload)).toEqual({ status: 'succeeded', name: 'source.txt' })

    const download = await invoke(event, {
      id: 'download-one',
      operation: 'download',
      assetId: 'asset',
      name: 'report.txt',
      size: body.length
    })

    expect(structuredClone(download)).toEqual({ status: 'succeeded', name: 'report.txt' })
    expect((await readFile(saved)).equals(body)).toBe(true)
    const second = path.join(root, 'second-saved.txt')
    showSaveDialog
      .mockResolvedValueOnce({ canceled: false, filePath: saved })
      .mockResolvedValueOnce({ canceled: false, filePath: second })

    const batch = await invoke(event, {
      id: 'download-batch',
      operation: 'download-many',
      assets: [
        { assetId: 'asset', name: 'first.txt', size: body.length },
        { assetId: 'second', name: 'second.txt', size: body.length }
      ]
    })

    expect(batch).toMatchObject({ status: 'succeeded' })
    expect((await readFile(second)).equals(body)).toBe(true)
    expect(sender.send.mock.calls.some(([, progress]) => progress.fileIndex === 2 && progress.fileCount === 2)).toBe(
      true
    )
    const part = calls.find(call => call.route.endsWith('/drive/upload-part'))!
    expect(part.body.equals(body)).toBe(true)
    expect(part).toMatchObject({ authorization: 'Bearer secret-login', drive: 'secret-drive' })
    expect(calls.find(call => call.route.includes('/drive/content?'))).toMatchObject({
      authorization: 'Bearer secret-login',
      drive: 'secret-drive'
    })
    expect(JSON.stringify(sender.send.mock.calls)).not.toMatch(/secret-/)
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain(root)
    expect(sender.send.mock.calls.some(([, progress]) => progress.name === 'source.txt')).toBe(true)
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
    await expect(invoke({ sender }, { id: 'forged', operation: 'upload', parentAssetId: 'root' })).rejects.toThrow(
      '无效'
    )
    expect(showOpenDialog).toHaveBeenCalledTimes(1)
    expect((await readdir(root)).some(name => name.endsWith('.part'))).toBe(false)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
    vi.clearAllMocks()
  }
})
