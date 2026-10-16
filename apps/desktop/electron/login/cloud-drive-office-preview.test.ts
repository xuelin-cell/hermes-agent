import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { OFFICE_EXTENSIONS } from '../../../shared/src/office-preview'
import { convertLibreOffice } from '../office-preview/convert-libreoffice'
import { runOfficeProcess } from '../office-preview/run-process'
import { createOfficePreviewService } from '../office-preview/service'

const { handle, fromWebContents } = vi.hoisted(() => ({ handle: vi.fn(), fromWebContents: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle },
  BrowserWindow: { fromWebContents },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }
}))

import { CloudDriveClient } from './cloud-drive'
import { CLOUD_DRIVE_PREVIEW_BYTES, createCloudDriveOfficePreview } from './cloud-drive-office-preview'
import { installCloudDriveTransferIpc } from './cloud-drive-transfer-ipc'
import { CloudDriveTransfers } from './cloud-drive-transfers'

let root: string

const identity = {
  uid: 'account-a',
  token: 'private-login',
  phone: '13800000000',
  maskedPhone: '138****0000',
  expiresAt: Date.now() + 600_000
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hermes-cloud-office-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  vi.clearAllMocks()
})

/** 正式下载、账号守卫和文件清理保持真实，只替换网络内容及必要的转换软件出口。 */
function fixture(convert: ReturnType<typeof createOfficePreviewService>['convert']) {
  const content = Buffer.from('office source')

  const request = vi.fn<typeof fetch>(async url => {
    const route = new URL(String(url)).pathname

    if (route.endsWith('/access-token')) {
      return Response.json({ meta: { code: '' }, result: { accessToken: 'private-drive' } })
    }

    if (route.endsWith('/unicom/FileDetails')) {
      return Response.json({ ok: true, data: { fid: 'file-one' } })
    }

    if (route.endsWith('/assets/download')) {
      return Response.json({ ok: true, data: { download_path: '/drive/content?fid=file-one' } })
    }

    return new Response(content, { headers: { 'content-length': String(content.length) } })
  })

  const cache = path.join(root, 'download-cache')
  let account = { ...identity }
  const drive = new CloudDriveClient(() => account, request)
  const transfers = new CloudDriveTransfers(drive, cache, createCloudDriveOfficePreview({ convert }))
  const host = { selectUpload: async () => null, selectDownload: async () => null, progress: vi.fn() }

  const input = {
    id: 'office-preview',
    operation: 'preview' as const,
    assetId: 'asset',
    name: '报告.docx',
    size: content.length
  }

  return {
    transfers,
    cache,
    input,
    host,
    request,
    changeAccount: () => {
      account = { ...identity, uid: 'account-b' }
    }
  }
}

it('转换失败仅返回固定原因，下载临时目录被清理，超大 PDF 不跨 IPC 返回', async () => {
  const convert = vi.fn<ReturnType<typeof createOfficePreviewService>['convert']>()
  const data = fixture(convert)

  const failures = {
    unavailable: 'OFFICE_PREVIEW_UNAVAILABLE',
    timeout: 'OFFICE_PREVIEW_TIMEOUT',
    convert_failed: 'OFFICE_PREVIEW_FAILED',
    not_found: 'OFFICE_PREVIEW_FAILED',
    too_large: 'PREVIEW_TOO_LARGE',
    unsupported: 'PREVIEW_UNSUPPORTED'
  } as const

  for (const [code, expected] of Object.entries(failures)) {
    convert.mockResolvedValueOnce({ ok: false, code: code as keyof typeof failures })
    expect(await data.transfers.run(1, data.input, data.host)).toMatchObject({ status: 'failed', code: expected })
    expect(await readdir(data.cache)).toEqual([])
  }

  convert.mockResolvedValueOnce({
    ok: true,
    converter: 'libreoffice',
    version: 'v1',
    pdf: Buffer.alloc(CLOUD_DRIVE_PREVIEW_BYTES + 1)
  })
  const result = await data.transfers.run(1, data.input, data.host)
  expect(result).toMatchObject({ status: 'failed', code: 'PREVIEW_TOO_LARGE' })
  expect(JSON.stringify(result)).not.toContain(root)
  expect(await readdir(data.cache)).toEqual([])
})

it('源文件过大、下载不完整或转换服务未接入时不启动转换', async () => {
  const convert = vi.fn<ReturnType<typeof createOfficePreviewService>['convert']>()
  const data = fixture(convert)
  expect(await data.transfers.run(1, { ...data.input, size: CLOUD_DRIVE_PREVIEW_BYTES + 1 }, data.host)).toMatchObject({
    status: 'failed',
    code: 'PREVIEW_TOO_LARGE'
  })
  expect(data.request).not.toHaveBeenCalled()
  expect(await data.transfers.run(1, { ...data.input, size: data.input.size + 1 }, data.host)).toMatchObject({
    status: 'failed',
    code: 'SIZE_MISMATCH'
  })
  expect(await readdir(data.cache)).toEqual([])
  const plain = new CloudDriveTransfers(new CloudDriveClient(() => identity, data.request), data.cache)
  expect(await plain.run(1, data.input, data.host)).toMatchObject({
    status: 'failed',
    code: 'OFFICE_PREVIEW_UNAVAILABLE'
  })
  expect(convert).not.toHaveBeenCalled()
})

it.each(['cancel', 'account-change'] as const)('转换期间 %s 不发布迟到预览，源文件保留到转换安全结束', async action => {
  let finish!: (value: Awaited<ReturnType<ReturnType<typeof createOfficePreviewService>['convert']>>) => void
  let source = ''
  let signal!: AbortSignal

  const data = fixture(async (file, currentSignal) => {
    source = file
    signal = currentSignal!
    expect(await readFile(file, 'utf8')).toBe('office source')

    return await new Promise(resolve => {
      finish = resolve
    })
  })

  const pending = data.transfers.run(1, data.input, data.host)
  await vi.waitFor(() => expect(finish).toBeDefined())
  expect(data.host.progress).toHaveBeenLastCalledWith({
    id: data.input.id,
    completed: data.input.size,
    total: data.input.size,
    phase: 'converting'
  })

  if (action === 'cancel') {
    data.transfers.cancel(1, data.input.id)
  } else {
    data.changeAccount()
  }

  await vi.waitFor(() => expect(signal.aborted).toBe(true))
  expect(await readFile(source, 'utf8')).toBe('office source')
  finish({ ok: true, converter: 'libreoffice', version: 'v1', pdf: Buffer.from('%PDF-1.7') })
  const result = await pending
  expect(result).toMatchObject(
    action === 'cancel' ? { status: 'cancelled' } : { status: 'failed', code: 'AUTH_CHANGED' }
  )
  expect(result).not.toHaveProperty('preview')
  expect(await readdir(data.cache)).toEqual([])
})

it('真实 HTTP→IPC→Office 服务→转换子进程返回 PDF，账号 A→B→A 与全部登记格式不串文件', async () => {
  const script = path.join(root, 'converter-fixture.cjs')
  await writeFile(
    script,
    `const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
const source = args.at(-1); const out = args[args.indexOf('--outdir') + 1];
if (!args.includes('--headless') || !args.includes('--convert-to')) process.exit(2);
fs.writeFileSync(path.join(out, path.basename(source, path.extname(source)) + '.pdf'), Buffer.concat([Buffer.from('%PDF-1.7\\n'), fs.readFileSync(source), Buffer.from('\\n%%EOF')]));
`
  )

  let bytes = Buffer.from('account-a')

  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    const route = new URL(req.url!, 'http://fixture').pathname

    if (route.endsWith('/access-token')) {
      res.end(JSON.stringify({ meta: { code: '' }, result: { accessToken: 'drive-secret' } }))

      return
    }

    expect(req.headers.authorization).toBe('Bearer private-login')
    expect(req.headers['x-drive-access-token']).toBe('drive-secret')

    if (route.endsWith('/unicom/FileDetails')) {
      res.end(JSON.stringify({ ok: true, data: { fid: 'same-file' } }))
    } else if (route.endsWith('/assets/download')) {
      res.end(JSON.stringify({ ok: true, data: { download_path: '/drive/content?fid=same-file' } }))
    } else {
      res.setHeader('content-length', bytes.length)
      res.end(bytes)
    }
  })

  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const request: typeof fetch = (url, options) => {
      const parsed = new URL(String(url))

      return fetch(origin + parsed.pathname + parsed.search, options)
    }

    const program = { provider: 'libreoffice' as const, executable: path.join(root, 'soffice.exe') }
    await writeFile(program.executable, 'fixture')
    await writeFile(path.join(root, 'soffice.com'), 'fixture')

    const detector = {
      get: async () => ({ word: [program], slides: [program], sheet: [program] }),
      invalidate: () => {}
    }

    for (const account of ['account-a', 'account-b', 'account-a']) {
      const state = path.join(root, account)
      const sourceCache = path.join(state, 'cloud-download')
      await mkdir(state, { recursive: true })

      const service = createOfficePreviewService(state, {
        detector,
        libreoffice: (program, file, directory, timeout) =>
          convertLibreOffice(program, file, directory, timeout, (_exe, args, options) =>
            runOfficeProcess(process.execPath, [script, ...args], options)
          )
      })

      const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: vi.fn() })
      const event = { sender }
      fromWebContents.mockReturnValue({ webContents: sender })
      installCloudDriveTransferIpc(
        new CloudDriveClient(() => ({ ...identity, uid: account }), request),
        sourceCache,
        candidate => (candidate as unknown) === event,
        undefined,
        createCloudDriveOfficePreview(service)
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

        expect(result).toMatchObject({ status: 'succeeded', name: '中文.' + extension, preview: { kind: 'pdf' } })
        expect(Buffer.from(result.preview.dataUrl.split(',')[1], 'base64').toString()).toContain(bytes.toString())
        expect(await readdir(sourceCache)).toEqual([])
        expect(JSON.stringify([result, sender.send.mock.calls])).not.toMatch(/private-login|drive-secret/)
        expect(JSON.stringify(result)).not.toContain(state)
      }
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
