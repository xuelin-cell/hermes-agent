import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { CloudDriveClient } from './cloud-drive'
import { CloudDriveTransfers } from './cloud-drive-transfers'

const savedIdentity = {
  uid: 'user',
  token: 'private-login',
  phone: '13800000000',
  maskedPhone: '138****0000',
  expiresAt: Date.now() + 600_000
}

let identity: typeof savedIdentity | null
let root: string
let request: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hermes-drive-transfer-'))
  identity = { ...savedIdentity }
  request = vi.fn<typeof fetch>(async url => {
    const route = new URL(String(url)).pathname

    if (route.endsWith('access-token')) {
      return Response.json({ meta: { code: '' }, result: { accessToken: 'private-drive' } })
    }

    if (route.endsWith('/drive/capabilities')) {
      return Response.json({ ok: true, data: { upload: true } })
    }

    if (route.endsWith('/unicom/FileDetails')) {
      return Response.json({ ok: true, data: { fid: 'fid-one' } })
    }

    if (route.endsWith('/assets/download')) {
      return Response.json({ ok: true, data: { download_path: '/drive/content?fid=fid-one' } })
    }

    if (route.endsWith('/drive/content')) {
      return new Response('hello', { headers: { 'Content-Length': '5' } })
    }

    throw new Error('Unexpected request')
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 创建真实文件和主进程客户端，网络只使用可控响应。 */
function fixture() {
  const drive = new CloudDriveClient(() => identity, request)
  const transfers = new CloudDriveTransfers(drive, path.join(root, 'cache'))

  const host = {
    selectUpload: vi.fn(async () => path.join(root, '中文.txt')),
    selectDownload: vi.fn(async (): Promise<string | null> => path.join(root, 'saved.txt')),
    progress: vi.fn()
  }

  return { transfers, host }
}

it('原生选择的文件按 8 MiB 顺序上传，上传元信息和认证均不经过页面', async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 11, 42)
  await writeFile(path.join(root, '中文.txt'), bytes)
  const { transfers, host } = fixture()
  const original = request.getMockImplementation()!
  const parts: { metadata: Record<string, string | number>; bytes: Buffer }[] = []
  request.mockImplementation(async (url, options) => {
    if (!String(url).endsWith('/drive/upload-part')) {
      return original(url, options)
    }

    const headers = new Headers(options?.headers)
    expect(headers.get('Authorization')).toBe('Bearer private-login')
    expect(headers.get('X-Drive-Access-Token')).toBe('private-drive')
    expect(options?.redirect).toBe('error')
    const metadata = JSON.parse(Buffer.from(headers.get('X-Drive-Upload-Metadata')!, 'base64').toString())
    parts.push({ metadata, bytes: Buffer.from(options!.body as Uint8Array) })

    return Response.json({
      ok: true,
      status: metadata.partIndex === metadata.totalPart ? 'succeeded' : 'accepted',
      data: {}
    })
  })
  const result = await transfers.run(1, { id: 'upload-1', operation: 'upload', parentAssetId: 'real-root' }, host)
  expect(result).toEqual({ status: 'succeeded', name: '中文.txt' })
  expect(parts).toHaveLength(2)
  expect(parts[0].metadata).toMatchObject({
    fileName: '中文.txt',
    fileSize: bytes.length,
    totalPart: 2,
    partIndex: 1,
    directoryId: 'real-root',
    partSize: 8 * 1024 * 1024
  })
  expect(parts[1].metadata).toMatchObject({ uniqueId: parts[0].metadata.uniqueId, partIndex: 2, partSize: 11 })
  expect(Buffer.concat(parts.map(part => part.bytes)).equals(bytes)).toBe(true)
  expect(host.progress.mock.calls.some(([value]) => value.phase === 'verifying' && value.name === '中文.txt')).toBe(
    true
  )
})

it('批量下载在同一账号守卫下顺序保存，保存框取消当前文件后继续下一个', async () => {
  const { transfers, host } = fixture()
  const first = path.join(root, 'first.txt')
  const second = path.join(root, 'second.txt')
  host.selectDownload.mockResolvedValueOnce(null).mockResolvedValueOnce(first).mockResolvedValueOnce(second)

  const result = await transfers.run(
    1,
    {
      id: 'batch-one',
      operation: 'download-many',
      assets: [
        { assetId: 'skip', name: 'skip.txt', size: 5 },
        { assetId: 'first', name: 'first.txt', size: 5 },
        { assetId: 'second', name: 'second.txt', size: 5 }
      ]
    },
    host
  )

  expect(result).toMatchObject({ status: 'succeeded' })
  expect(result.files).toEqual([
    { index: 0, name: 'skip.txt', status: 'cancelled' },
    { index: 1, name: 'first.txt', status: 'succeeded' },
    { index: 2, name: 'second.txt', status: 'succeeded' }
  ])
  expect(await readFile(first, 'utf8')).toBe('hello')
  expect(await readFile(second, 'utf8')).toBe('hello')
  expect(host.progress).toHaveBeenLastCalledWith({
    id: 'batch-one',
    completed: 5,
    total: 5,
    name: 'second.txt',
    fileIndex: 3,
    fileCount: 3,
    fileStatus: 'succeeded'
  })
})

it('上传大小限制和服务容量拒绝保留具体错误码，不发出分片或重复提交', async () => {
  await writeFile(path.join(root, '中文.txt'), 'hello')
  const original = request.getMockImplementation()!
  request.mockImplementation(async (url, options) =>
    String(url).endsWith('/drive/capabilities')
      ? Response.json({ ok: true, data: { upload: true, max_upload_bytes: 1 } })
      : original(url, options)
  )
  const { transfers, host } = fixture()
  expect(await transfers.run(1, { id: 'too-large', operation: 'upload', parentAssetId: 'root' }, host)).toMatchObject({
    status: 'failed',
    code: 'FILE_TOO_LARGE'
  })
  expect(request.mock.calls.some(([url]) => String(url).endsWith('/drive/upload-part'))).toBe(false)
  request.mockImplementation(async (url, options) =>
    String(url).endsWith('/drive/upload-part')
      ? Response.json({ ok: false, status: 'failed', error: { code: 'QUOTA_EXCEEDED', message: 'private-details' } })
      : original(url, options)
  )
  const result = await transfers.run(1, { id: 'quota', operation: 'upload', parentAssetId: 'root' }, host)
  expect(result).toMatchObject({ status: 'failed', code: 'QUOTA_EXCEEDED' })
  expect(request.mock.calls.filter(([url]) => String(url).endsWith('/drive/upload-part'))).toHaveLength(1)
  expect(JSON.stringify(result)).not.toMatch(/private-/)
})

it('取消整个下载批次或账号切换时不打开后续保存框；已保存文件保留', async () => {
  const { transfers, host } = fixture()
  const assets = [1, 2, 3].map(index => ({ assetId: String(index), name: `${index}.txt`, size: 5 }))
  host.selectDownload.mockImplementationOnce(async () => {
    transfers.cancel(1, 'cancel-batch')

    return path.join(root, 'cancelled.txt')
  })
  expect(await transfers.run(1, { id: 'cancel-batch', operation: 'download-many', assets }, host)).toEqual({
    status: 'cancelled',
    files: [
      { index: 0, name: '1.txt', status: 'cancelled' },
      { index: 1, name: '2.txt', status: 'not_started' },
      { index: 2, name: '3.txt', status: 'not_started' }
    ]
  })
  expect(host.selectDownload).toHaveBeenCalledTimes(1)
  expect(request).not.toHaveBeenCalled()

  const first = path.join(root, 'first.txt')
  host.selectDownload.mockClear()
  host.selectDownload.mockResolvedValueOnce(first).mockImplementationOnce(async () => {
    identity = { ...savedIdentity, uid: 'other-account' }

    return path.join(root, 'never-saved.txt')
  })
  expect(await transfers.run(1, { id: 'account-batch', operation: 'download-many', assets }, host)).toMatchObject({
    status: 'partial_success'
  })
  expect(host.selectDownload).toHaveBeenCalledTimes(2)
  expect(await readFile(first, 'utf8')).toBe('hello')
  expect(await readdir(root)).not.toContain('never-saved.txt')
  expect(await readdir(root)).not.toContain('3.txt')
})

it('批量下载拒绝任意路径式名称和损坏项目，一项未通过就不打开保存框', async () => {
  const { transfers, host } = fixture()

  for (const assets of [
    [],
    [{ assetId: 'safe', name: '../secret.txt' }],
    [{ assetId: 'safe', name: 'safe.txt', size: -1 }]
  ]) {
    expect(await transfers.run(1, { id: 'invalid-batch', operation: 'download-many', assets }, host)).toMatchObject({
      status: 'failed',
      code: 'INVALID_ARGUMENT'
    })
  }

  expect(host.selectDownload).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
})

it('末片已发但响应丢失保留未知状态，绝不重传', async () => {
  await writeFile(path.join(root, '中文.txt'), 'content')
  const { transfers, host } = fixture()
  const original = request.getMockImplementation()!
  request.mockImplementation(async (url, options) => {
    if (String(url).endsWith('/drive/upload-part')) {
      throw new Error('Connection closed after storing')
    }

    return original(url, options)
  })
  expect(await transfers.run(1, { id: 'upload-1', operation: 'upload', parentAssetId: 'root' }, host)).toMatchObject({
    status: 'outcome_unknown',
    code: 'UPLOAD_INTERRUPTED'
  })
  expect(request.mock.calls.filter(([url]) => String(url).endsWith('/drive/upload-part'))).toHaveLength(1)
})

it('中间片失败不会继续发送，大小上限会阻止上传', async () => {
  await writeFile(path.join(root, '中文.txt'), Buffer.alloc(8 * 1024 * 1024 + 1))
  const { transfers, host } = fixture()
  const original = request.getMockImplementation()!
  request.mockImplementation(async (url, options) => {
    if (String(url).endsWith('/drive/upload-part')) {
      throw new Error('Disconnected')
    }

    return original(url, options)
  })
  expect(await transfers.run(1, { id: 'upload-1', operation: 'upload', parentAssetId: 'root' }, host)).toMatchObject({
    status: 'failed',
    code: 'UPLOAD_INCOMPLETE'
  })
  expect(request.mock.calls.filter(([url]) => String(url).endsWith('/drive/upload-part'))).toHaveLength(1)
  request.mockImplementation(async (url, options) =>
    String(url).endsWith('/drive/capabilities')
      ? Response.json({ ok: true, data: { upload: true, max_upload_bytes: 1 } })
      : original(url, options)
  )
  expect(await transfers.run(1, { id: 'upload-2', operation: 'upload', parentAssetId: 'root' }, host)).toMatchObject({
    status: 'failed',
    code: 'FILE_TOO_LARGE'
  })
})

it('下载使用授权中转并校验长度，失败不覆盖已有文件且清理临时文件', async () => {
  const { transfers, host } = fixture()
  await writeFile(path.join(root, 'saved.txt'), 'existing')
  const input = { id: 'download-1', operation: 'download' as const, assetId: 'asset-one', name: 'report.txt', size: 6 }
  expect(await transfers.run(1, input, host)).toMatchObject({ status: 'failed', code: 'SIZE_MISMATCH' })
  expect(await readFile(path.join(root, 'saved.txt'), 'utf8')).toBe('existing')
  expect((await readdir(root)).some(name => name.endsWith('.part'))).toBe(false)
  expect(await transfers.run(1, { ...input, size: 5 }, host)).toEqual({ status: 'succeeded', name: 'report.txt' })
  expect(await readFile(path.join(root, 'saved.txt'), 'utf8')).toBe('hello')
  const content = request.mock.calls.find(([url]) => String(url).includes('/drive/content?'))!
  expect(content[1]).toMatchObject({
    redirect: 'error',
    headers: { Authorization: 'Bearer private-login', 'X-Drive-Access-Token': 'private-drive' }
  })
})

it('预览返回有限字节并清理缓存，HTML 作为文本且无需 Agent 或本机路径', async () => {
  const { transfers, host } = fixture()

  const result = await transfers.run(
    1,
    { id: 'preview-1', operation: 'preview', assetId: 'asset', name: 'report.html', size: 5 },
    host
  )

  expect(result).toEqual({
    status: 'succeeded',
    name: 'report.html',
    preview: { kind: 'text', dataUrl: 'data:text/plain;base64,aGVsbG8=' }
  })
  expect(await readdir(path.join(root, 'cache'))).toEqual([])
  expect(host.selectDownload).not.toHaveBeenCalled()
  expect(JSON.stringify(result)).not.toContain(root)
  expect(
    await transfers.run(
      1,
      { id: 'preview-2', operation: 'preview', assetId: 'asset', name: 'report.pdf', size: 17 * 1024 * 1024 },
      host
    )
  ).toMatchObject({ status: 'failed', code: 'PREVIEW_TOO_LARGE' })
})

it('拒绝服务返回的非授权下载路径，不向任意来源发送凭据', async () => {
  const { transfers, host } = fixture()
  const original = request.getMockImplementation()!

  for (const relay of [
    'https://evil.invalid/file',
    '/drive/content?fid=other',
    '/drive/content?fid=fid-one&url=evil',
    '/drive/content?fid=fid-one&fid=fid-one',
    '/drive/content?fid=fid-one#fragment'
  ]) {
    request.mockImplementation(async (url, options) =>
      String(url).endsWith('/assets/download')
        ? Response.json({ ok: true, data: { download_path: relay } })
        : original(url, options)
    )
    expect(
      await transfers.run(1, { id: 'download-1', operation: 'download', assetId: 'asset', name: 'safe.txt' }, host)
    ).toMatchObject({ status: 'failed' })
  }

  expect(
    request.mock.calls.some(([url]) => String(url).includes('/drive/content?') || String(url).includes('evil.invalid'))
  ).toBe(false)
})

it('取消只作用于所属窗口，账号切换后不发送或保存旧文件', async () => {
  const { transfers, host } = fixture()
  let select!: (value: string | null) => void
  host.selectDownload.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        select = resolve
      })
  )
  const input = { id: 'download-1', operation: 'download' as const, assetId: 'asset', name: 'safe.txt' }
  const pending = transfers.run(1, input, host)
  transfers.cancel(2, input.id)
  transfers.cancel(1, 'different-id')
  expect(await transfers.run(1, input, host)).toMatchObject({ status: 'failed', code: 'INVALID_ARGUMENT' })
  transfers.cancel(1, input.id)
  select(path.join(root, 'saved.txt'))
  expect(await pending).toEqual({ status: 'cancelled' })
  expect(request).not.toHaveBeenCalled()
  host.selectDownload.mockImplementationOnce(async () => {
    identity = { ...savedIdentity, uid: 'other' }

    return path.join(root, 'saved.txt')
  })
  expect(await transfers.run(1, input, host)).toMatchObject({ status: 'failed', code: 'AUTH_CHANGED' })
  expect(request).not.toHaveBeenCalled()
})

it('上传途中本机文件改变时停止，不把不同快照的分片合成文件', async () => {
  const filename = path.join(root, '中文.txt')
  await writeFile(filename, Buffer.alloc(8 * 1024 * 1024 + 1))
  const { transfers, host } = fixture()
  const original = request.getMockImplementation()!
  request.mockImplementation(async (url, options) => {
    if (String(url).endsWith('/drive/upload-part')) {
      await writeFile(filename, 'changed')

      return Response.json({ ok: true, status: 'accepted', data: {} })
    }

    return original(url, options)
  })
  expect(await transfers.run(1, { id: 'upload-1', operation: 'upload', parentAssetId: 'root' }, host)).toMatchObject({
    status: 'failed',
    code: 'FILE_CHANGED'
  })
  expect(request.mock.calls.filter(([url]) => String(url).endsWith('/drive/upload-part'))).toHaveLength(1)
})

it('传输中取消和账号切换都清理半个文件，不覆盖保存目标', async () => {
  const { transfers, host } = fixture()
  const original = request.getMockImplementation()!
  const input = { id: 'download-1', operation: 'download' as const, assetId: 'asset', name: 'safe.txt', size: 5 }
  await writeFile(path.join(root, 'saved.txt'), 'existing')
  request.mockImplementation(async (url, options) => {
    if (!String(url).includes('/drive/content?')) {
      return original(url, options)
    }

    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('he'))
          controller.enqueue(new TextEncoder().encode('llo'))
          controller.close()
        }
      })
    )
  })
  host.progress.mockImplementationOnce(() => {
    transfers.cancel(1, input.id)
  })
  expect(await transfers.run(1, input, host)).toEqual({ status: 'cancelled' })
  host.progress.mockImplementationOnce(() => {
    identity = { ...savedIdentity, uid: 'another-user' }
  })
  expect(await transfers.run(1, input, host)).toMatchObject({ status: 'failed', code: 'AUTH_CHANGED' })
  expect(await readFile(path.join(root, 'saved.txt'), 'utf8')).toBe('existing')
  expect((await readdir(root)).some(name => name.endsWith('.part'))).toBe(false)
})

it('上传最后一片保留部分成功、未知和明确失败，接受中不误报完成', async () => {
  const { transfers, host } = fixture()
  await writeFile(path.join(root, '中文.txt'), 'hello')
  const original = request.getMockImplementation()!

  for (const [status, expected] of [
    ['partial_success', 'partial_success'],
    ['outcome_unknown', 'outcome_unknown'],
    ['failed', 'failed'],
    ['accepted', 'outcome_unknown']
  ]) {
    request.mockImplementation(async (url, options) =>
      String(url).endsWith('/drive/upload-part')
        ? Response.json({ ok: true, status, data: {} })
        : original(url, options)
    )
    expect(await transfers.run(1, { id: 'upload-1', operation: 'upload', parentAssetId: 'root' }, host)).toMatchObject({
      status: expected
    })
  }

  expect(request.mock.calls.filter(([url]) => String(url).endsWith('/drive/upload-part'))).toHaveLength(4)
})
