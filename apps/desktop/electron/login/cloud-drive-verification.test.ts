import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type * as TimerPromises from 'node:timers/promises'

import { expect, it, vi } from 'vitest'

// 只压缩核验等待时间；文件句柄、客户端、HTTP、鉴权和响应解析均走真实链路。
vi.mock('node:timers/promises', async original => {
  const timers = await original<typeof TimerPromises>()

  return {
    ...timers,
    setTimeout: (_wait: number, value: unknown, options: { signal?: AbortSignal }) =>
      timers.setTimeout(1, value, options)
  }
})

import { CloudDriveClient } from './cloud-drive'
import { CloudDriveTransfers } from './cloud-drive-transfers'
import type { VerificationAsset } from './cloud-drive-verification'
import type { CloudDriveRequest, CloudDriveTransferProgress } from './contract'

const account = (uid: string) => ({
  uid,
  token: `login-${uid}`,
  phone: '13800000000',
  maskedPhone: '138****0000',
  expiresAt: Date.now() + 600000
})

const asset = (
  id: string,
  name = 'sample.txt',
  parent = '0',
  kind: 'file' | 'directory' = 'file'
): VerificationAsset => ({
  asset_id: id,
  name,
  kind,
  parent_asset_id: parent,
  size_bytes: 7,
  fid: kind === 'file' ? `fid-${id}` : '0'
})

/** 所有生产域名只映射到本机临时服务，绝不访问真实云盘。 */
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'drive-verification-'))
  let identity = account('A')
  let mode = 'stored'
  let writes = 0
  let reads = 0
  let uploaded = 0
  let onUpload: (() => void) | undefined
  let onProgress: ((value: CloudDriveTransferProgress) => void) | undefined
  let rows = [asset('old')]
  let recycled: Record<string, unknown>[] = []
  const calls: { method: string; path: string; account: string | undefined }[] = []

  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://local')
    const route = url.pathname.replace(/^.*\/clouddrive\/v1/, '')
    const chunks: Buffer[] = []

    for await (const chunk of request) {
      chunks.push(chunk)
    }

    const body =
      request.headers['content-type'] === 'application/json' && chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : {}

    calls.push({ method: request.method!, path: route, account: request.headers.authorization })
    const ok = (data: unknown) => response.end(JSON.stringify({ ok: true, status: 'succeeded', data }))

    const unknown = () =>
      response.end(JSON.stringify({ ok: false, status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' } }))

    response.setHeader('Content-Type', 'application/json')

    if (route.endsWith('access-token')) {
      response.end(JSON.stringify({ meta: { code: '' }, result: { accessToken: `drive-${identity.uid}` } }))

      return
    }

    if (route === '/drive/capabilities') {
      ok({ upload: true })

      return
    }

    if (route === '/assets' && request.method === 'GET') {
      reads++

      if (
        mode === 'no-baseline' ||
        (['read-error', 'ack-read-error'].includes(mode) && writes) ||
        (mode === 'mixed-read-error' && reads === 3)
      ) {
        response.destroy()

        return
      }

      const items = rows.filter(row => row.parent_asset_id === url.searchParams.get('parent_asset_id'))

      if (mode === 'paged') {
        const page = Number(url.searchParams.get('page_no'))
        ok({ items: page === 1 ? items.slice(0, 1) : items.slice(1), page: { has_more: page === 1 } })
      } else {
        ok({ items, page: { has_more: false } })
      }

      return
    }

    if (route === '/unicom/FileDetails') {
      ok({ fid: `fid-${body.fileId}` })

      return
    }

    if (route === '/unicom/QueryRecycleData') {
      ok(recycled)

      return
    }

    writes++

    if (route === '/drive/upload-part') {
      const metadata = JSON.parse(Buffer.from(String(request.headers['x-drive-upload-metadata']), 'base64').toString())

      if (mode === 'denied') {
        response.end(JSON.stringify({ ok: false, status: 'failed', error: { code: 'PERMISSION_DENIED' } }))

        return
      }

      if (mode === 'ack') {
        ok({})

        return
      }

      if (!['absent', 'mixed-read-error', 'intermediate'].includes(mode)) {
        rows.push(asset(`new-${++uploaded}`, metadata.fileName))

        if (mode === 'missing-size') {
          rows.at(-1)!.size_bytes = null
        }

        if (mode === 'ambiguous') {
          rows.push(asset(`extra-${uploaded}`, metadata.fileName))
        }
      }

      onUpload?.()

      if (mode === 'failed-network') {
        response.end(JSON.stringify({ ok: false, status: 'failed', error: { code: 'NETWORK_ERROR' } }))

        return
      }

      response.destroy()

      return
    }

    if (mode === 'denied') {
      response.end(JSON.stringify({ ok: false, status: 'failed', error: { code: 'PERMISSION_DENIED' } }))

      return
    }

    if (route === '/folders') {
      rows.push(asset('folder-new', body.name, body.parent_asset_id, 'directory'))
    }

    if (request.method === 'PATCH') {
      rows.find(row => row.asset_id === 'old')!.name = body.new_name
    }

    if (route === '/assets/move') {
      rows.find(row => row.asset_id === 'old')!.parent_asset_id = body.target_parent_asset_id
    }

    if (route === '/assets/trash') {
      if (mode === 'trash-denied') {
        response.end(
          JSON.stringify({
            ok: false,
            status: 'failed',
            data: { item_results: [{ asset_id: 'old', ok: false, error: { code: 'PERMISSION_DENIED' } }] },
            error: { code: 'OPERATION_FAILED' }
          })
        )

        return
      }

      if (mode === 'foreign-recycle') {
        recycled.push({
          deleteNo: 'foreign-delete',
          fid: 'fid-foreign',
          openFileId: 999,
          type: '1',
          name: 'sample.txt'
        })
        unknown()

        return
      }

      const source = rows.find(row => row.asset_id === 'old')!
      rows = rows.filter(row => row.asset_id !== 'old')

      if (mode === 'concurrent-move') {
        rows.push({ ...source, parent_asset_id: 'destination' })
      }

      const deletedRow = {
        deleteNo: 'delete-old',
        fid: source.kind === 'file' ? 'fid-old' : '0',
        openFileId: source.kind === 'file' ? 123 : 0,
        type: source.kind === 'file' ? '1' : '0',
        name: source.name,
        fileSize: '7'
      }

      if (mode !== 'existing-recycle') {
        recycled.push(deletedRow)
      }

      if (mode === 'duplicate-recycle') {
        recycled.push({ ...deletedRow, deleteNo: 'another-delete' })
      }

      if (mode === 'ack' || mode === 'ack-read-error') {
        ok({ item_results: [{ asset_id: 'old', ok: true }] })

        return
      }
    }

    if (route === '/unicom/ReductionRecycleData') {
      recycled = []

      if (!['restore-missing', 'existing-file'].includes(mode)) {
        rows.push(asset('old', 'sample.txt', '0', mode === 'folder-restore' ? 'directory' : 'file'))
      }

      if (mode === 'duplicate-restored') {
        rows.push({ ...asset('another'), fid: 'fid-old' })
      }

      if (mode === 'ack' || mode === 'ack-read-error') {
        ok({ verified: true, confirmed_by: 'provider_ack' })

        return
      }

      if (mode === 'service-state-read') {
        ok({ verified: true, confirmed_by: 'state_read' })

        return
      }
    }

    if (route === '/unicom/DeleteRecycleData' || route === '/unicom/EmptyRecycleData') {
      recycled = []
    }

    unknown()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port

  const transport: typeof fetch = (url, options) => {
    const remote = new URL(String(url))

    return fetch(`http://127.0.0.1:${port}${remote.pathname}${remote.search}`, options)
  }

  const client = new CloudDriveClient(() => identity, transport)
  const transfers = new CloudDriveTransfers(client, path.join(root, 'cache'))
  await writeFile(path.join(root, 'sample.txt'), 'content')
  const progress: CloudDriveTransferProgress[] = []

  const host = {
    selectUpload: async () => path.join(root, 'sample.txt'),
    selectDownload: async () => null,
    progress: (value: CloudDriveTransferProgress) => {
      progress.push(value)
      onProgress?.(value)
    }
  }

  return {
    root,
    client,
    transfers,
    calls,
    progress,
    reset(value: string, assets = [asset('old')], recycle: Record<string, unknown>[] = []) {
      mode = value
      writes = 0
      reads = 0
      uploaded = 0
      rows = assets
      recycled = recycle
      progress.length = 0
      calls.length = 0
      onUpload = undefined
      onProgress = undefined
    },
    onUpload: (callback: () => void) => {
      onUpload = callback
    },
    onProgress: (callback: (value: CloudDriveTransferProgress) => void) => {
      onProgress = callback
    },
    stats: () => ({ writes, reads }),
    switchTo: (uid: string) => {
      identity = account(uid)
    },
    upload: (owner = 1, target = transfers) =>
      target.run(owner, { id: `upload-${owner}`, operation: 'upload', parentAssetId: '0' }, host),
    async close() {
      transfers.cancelAll()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }
}

it('上传只有末片不确定才核验，完整读取、唯一新 ID 和三次有效查询决定最终结果，写分片从不重放', async () => {
  const f = await fixture()

  try {
    for (const [mode, status, code, count] of [
      ['stored', 'succeeded', undefined, 2],
      ['paged', 'succeeded', undefined, 4],
      ['absent', 'failed', 'UPLOAD_CONFIRMATION_FAILED', 4],
      ['read-error', 'outcome_unknown', 'UPLOAD_CONFIRMATION_UNAVAILABLE', 4],
      ['mixed-read-error', 'outcome_unknown', 'UPLOAD_CONFIRMATION_UNAVAILABLE', 4],
      ['missing-size', 'outcome_unknown', 'UPLOAD_CONFIRMATION_UNAVAILABLE', 4],
      ['failed-network', 'succeeded', undefined, 2],
      ['ambiguous', 'outcome_unknown', 'UPLOAD_CONFIRMATION_UNAVAILABLE', 4],
      ['no-baseline', 'outcome_unknown', 'UPLOAD_CONFIRMATION_UNAVAILABLE', 1],
      ['denied', 'failed', 'PERMISSION_DENIED', 1],
      ['ack', 'succeeded', undefined, 1]
    ] as const) {
      f.reset(mode)
      const result = await f.upload()
      expect(result.status, mode).toBe(status)

      if (code) {
        expect(result, mode).toHaveProperty('code', code)
      }

      expect(f.stats(), mode).toEqual({ writes: 1, reads: count })
      expect(
        f.progress.some(value => value.phase === 'verifying'),
        mode
      ).toBe(!['no-baseline', 'denied', 'ack'].includes(mode))
    }

    // GUI 与 MCP 各有传输实例，但同一客户端的锁保护相同签名，各自重新读取基线。
    f.reset('stored')
    const mcpTransfers = new CloudDriveTransfers(f.client, path.join(f.root, 'mcp-cache'))
    const results = await Promise.all([f.upload(1), f.upload(2, mcpTransfers)])
    expect(results.map(result => result.status)).toEqual(['succeeded', 'succeeded'])
    expect(
      f.calls.filter(call => call.path === '/assets' || call.path === '/drive/upload-part').map(call => call.method)
    ).toEqual(['GET', 'POST', 'GET', 'GET', 'POST', 'GET'])
    f.reset('stored')
    f.onUpload(() => f.transfers.cancel(1, 'upload-1'))
    expect(await f.upload()).toMatchObject({ status: 'succeeded' })
    expect(f.stats().writes).toBe(1)
    f.reset('stored')
    f.onProgress(value => {
      if (value.phase === 'verifying') {
        f.transfers.cancel(1)
      }
    })
    expect(await f.upload()).toMatchObject({ status: 'outcome_unknown' })
    expect(f.stats()).toEqual({ writes: 1, reads: 1 })
    f.reset('intermediate')
    await writeFile(path.join(f.root, 'sample.txt'), Buffer.alloc(8 * 1024 * 1024 + 1))
    expect(await f.upload()).toMatchObject({ status: 'failed', code: 'UPLOAD_INCOMPLETE' })
    expect(f.stats()).toEqual({ writes: 1, reads: 1 })
    expect(f.progress.some(value => value.phase === 'verifying')).toBe(false)
  } finally {
    await f.close()
  }
})

it('所有写操作只读核验目标身份，其他文件进入回收站或恢复目标缺失不能冒充成功；账号切换隔离核验', async () => {
  const f = await fixture()

  try {
    const deleted = [
      { deleteNo: 'delete-old', fid: 'fid-old', openFileId: 123, type: '1', name: 'sample.txt', fileSize: '7' }
    ]

    const cases: Array<{
      request: CloudDriveRequest
      rows?: VerificationAsset[]
      recycle?: Record<string, unknown>[]
    }> = [
      { request: { route: '/folders', method: 'POST', body: { parent_asset_id: '0', name: 'new-folder' } } },
      { request: { route: '/assets/old', method: 'PATCH', body: { new_name: 'renamed.txt', kind: 'file' } } },
      {
        request: {
          route: '/assets/move',
          method: 'POST',
          body: { file_ids: ['old'], target_parent_asset_id: 'destination' }
        }
      },
      { request: { route: '/assets/trash', method: 'POST', body: { file_ids: ['old'], directory_ids: [] } } },
      {
        request: { route: '/unicom/ReductionRecycleData', method: 'POST', body: { deleteNos: ['delete-old'] } },
        rows: [],
        recycle: deleted
      },
      {
        request: { route: '/unicom/DeleteRecycleData', method: 'POST', body: { deleteNos: ['delete-old'] } },
        rows: [],
        recycle: deleted
      },
      { request: { route: '/unicom/EmptyRecycleData', method: 'POST', body: {} }, rows: [], recycle: deleted }
    ]

    for (const entry of cases) {
      f.reset('stored', entry.rows, entry.recycle)
      const verifying = vi.fn()
      const result = await f.client.execute(entry.request, undefined, verifying)
      expect(result).toMatchObject({ verified: true })

      if (entry.request.route === '/folders') {
        expect(result).toHaveProperty('asset_id', 'folder-new')
      }

      expect(f.stats().writes).toBe(1)
      expect(verifying).toHaveBeenCalledOnce()
    }

    f.reset('foreign-recycle')
    await expect(f.client.execute(cases[3].request)).rejects.toMatchObject({
      result: { status: 'outcome_unknown', code: 'OPERATION_CONFIRMATION_UNAVAILABLE' }
    })
    expect(f.stats().writes).toBe(1)
    f.reset('restore-missing', [], deleted)
    await expect(f.client.execute(cases[4].request)).rejects.toMatchObject({ result: { status: 'outcome_unknown' } })
    expect(f.stats().writes).toBe(1)
    f.reset('denied')
    const verifying = vi.fn()
    await expect(f.client.execute(cases[0].request, undefined, verifying)).rejects.toMatchObject({
      result: { status: 'failed', code: 'PERMISSION_DENIED' }
    })
    expect(verifying).not.toHaveBeenCalled()
    f.reset('trash-denied')
    await expect(f.client.execute(cases[3].request)).rejects.toMatchObject({
      result: { status: 'failed', code: 'PERMISSION_DENIED' }
    })
    expect(f.stats().writes).toBe(1)
    f.reset('stored')
    await expect(f.client.execute(cases[0].request, undefined, () => f.switchTo('B'))).rejects.toMatchObject({
      result: { status: 'outcome_unknown' }
    })
    expect(f.calls.every(call => !call.account || call.account === 'Bearer login-A')).toBe(true)
    f.switchTo('A')
    f.reset('stored')
    expect(await f.client.execute(cases[0].request)).toMatchObject({ verified: true })
  } finally {
    await f.close()
  }
})

it('真实回收站 fid 关联文件身份，排除已有删除记录、已有文件和重复 fid；明确回执不受后续读取影响', async () => {
  const f = await fixture()

  const trash: CloudDriveRequest = {
    route: '/assets/trash',
    method: 'POST',
    body: { file_ids: ['old'], directory_ids: [] }
  }

  const restore: CloudDriveRequest = {
    route: '/unicom/ReductionRecycleData',
    method: 'POST',
    body: { deleteNos: ['delete-old'] }
  }

  const recycled = [
    { deleteNo: 'delete-old', fid: 'fid-old', openFileId: 123, type: '1', name: 'sample.txt', fileSize: '7' }
  ]

  try {
    f.reset('stored')
    expect(await f.client.execute(trash)).toMatchObject({ verified: true })
    expect(f.stats().writes).toBe(1)
    // 目录未返回 fid 时，使用 FileDetails 的真实 fileId 请求补取，不把 openFileId 当 asset_id。
    f.reset('stored', [{ ...asset('old'), fid: null }])
    expect(await f.client.execute(trash)).toMatchObject({ verified: true })
    expect(f.calls.some(call => call.path === '/unicom/FileDetails')).toBe(true)

    for (const mode of ['existing-recycle', 'duplicate-recycle', 'concurrent-move']) {
      f.reset(
        mode,
        mode === 'concurrent-move'
          ? [asset('old'), asset('destination', 'destination', '0', 'directory')]
          : [asset('old')],
        mode === 'existing-recycle' ? recycled : []
      )
      await expect(f.client.execute(trash)).rejects.toMatchObject({ result: { status: 'outcome_unknown' } })
      expect(f.stats().writes).toBe(1)
    }

    f.reset('stored', [], recycled)
    expect(await f.client.execute(restore)).toMatchObject({ verified: true })

    for (const mode of ['existing-file', 'duplicate-restored']) {
      f.reset(mode, mode === 'existing-file' ? [asset('old')] : [], recycled)
      await expect(f.client.execute(restore)).rejects.toMatchObject({ result: { status: 'outcome_unknown' } })
      expect(f.stats().writes).toBe(1)
    }

    for (const request of [trash, restore]) {
      f.reset('ack-read-error', request === restore ? [] : [asset('old')], request === restore ? recycled : [])
      const verifying = vi.fn()
      expect(await f.client.execute(request, undefined, verifying)).toBeTruthy()
      expect(verifying).not.toHaveBeenCalled()
      expect(f.stats().writes).toBe(1)
    }

    f.reset('service-state-read', [], recycled)
    expect(await f.client.execute(restore)).toMatchObject({ confirmed_by: 'state_read' })
  } finally {
    await f.close()
  }
})

it('文件夹 fid=0 不作为身份，正式成功回执直接保留；响应丢失时同名目录不能冒充恢复或删除成功', async () => {
  const f = await fixture()
  const source = asset('old', 'folder', '0', 'directory')
  const recycled = [{ deleteNo: 'delete-old', fid: '0', openFileId: 0, type: '0', name: 'folder', fileSize: '0' }]

  const requests: CloudDriveRequest[] = [
    { route: '/assets/trash', method: 'POST', body: { file_ids: [], directory_ids: ['old'] } },
    { route: '/unicom/ReductionRecycleData', method: 'POST', body: { deleteNos: ['delete-old'] } }
  ]

  try {
    for (const request of [
      { route: '/assets/old', method: 'PATCH', body: { kind: 'directory', new_name: 'renamed-folder' } },
      {
        route: '/assets/move',
        method: 'POST',
        body: { file_ids: [], directory_ids: ['old'], target_parent_asset_id: 'destination' }
      }
    ] satisfies CloudDriveRequest[]) {
      f.reset('stored', [source, asset('destination', 'destination', '0', 'directory')])
      expect(await f.client.execute(request)).toMatchObject({ verified: true })
      expect(f.stats().writes).toBe(1)
    }

    for (const request of requests) {
      const restoring = request.route.includes('Reduction')
      f.reset('ack-read-error', restoring ? [] : [source], restoring ? recycled : [])
      const verifying = vi.fn()
      expect(await f.client.execute(request, undefined, verifying)).toBeTruthy()
      expect(verifying).not.toHaveBeenCalled()
      expect(f.stats().writes).toBe(1)
      f.reset(restoring ? 'folder-restore' : 'stored', restoring ? [] : [source], restoring ? recycled : [])
      await expect(f.client.execute(request)).rejects.toMatchObject({ result: { status: 'outcome_unknown' } })
      expect(f.stats().writes).toBe(1)
    }
  } finally {
    await f.close()
  }
})
