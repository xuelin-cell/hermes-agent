import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import { CloudDriveClient } from './cloud-drive'
import { CloudDriveMcp } from './cloud-drive-mcp'
import { DRIVE_MCP_SERVER } from './drive-mcp-contract'

let root: string
let upstream: Server
let mcp: CloudDriveMcp
let drive: CloudDriveClient
let endpoint: string
let authorization: string
let identity: { uid: string; token: string; phone: string; maskedPhone: string; expiresAt: number }
let tokens: number
let onAcquire: (() => void) | undefined
let rejected: string
let contentMode: 'valid' | 'expire-once' | 'expired' | 'forbidden'
let rejectWrites: boolean
let rejectProbes: boolean
let calls: Array<{ route: string; token: string; authorization: string }>
let onRequest: ((route: string, response: ServerResponse) => boolean) | undefined
let onResponse: ((route: string, response: Response) => Promise<Response>) | undefined

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'drive-mcp-credentials-'))
  await mkdir(path.join(root, 'workspace'))
  identity = {
    uid: 'a',
    token: 'login-a',
    phone: '13800000000',
    maskedPhone: '138****0000',
    expiresAt: Date.now() + 3600_000
  }
  tokens = 0
  onAcquire = undefined
  rejected = ''
  contentMode = 'valid'
  rejectWrites = false
  rejectProbes = false
  calls = []
  onRequest = undefined
  onResponse = undefined
  upstream = createServer(async (request, response) => {
    // Consume write bytes too, so retry assertions count actual HTTP requests.
    for await (const _chunk of request) {
      /* consume */
    }

    const route = new URL(request.url!, 'http://local').pathname
    const token = String(request.headers['x-drive-access-token'] ?? '')
    calls.push({ route, token, authorization: String(request.headers.authorization ?? '') })

    const expired = () => {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: { code: 'DRIVE_AUTH_EXPIRED', provider_code: '9999' } }))
    }

    if (route === '/access-token') {
      response.setHeader('Content-Type', 'application/json')
      tokens++
      onAcquire?.()
      response.end(JSON.stringify({ meta: { code: '' }, result: { accessToken: `drive-${tokens}` } }))

      return
    }

    if (
      route !== '/asset-spaces' &&
      (token === rejected || (rejectWrites && route === '/folders') || (rejectProbes && route === '/assets'))
    ) {
      expired()

      return
    }

    if (route === '/drive/content') {
      if (contentMode === 'forbidden') {
        response.writeHead(403, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'PERMISSION_DENIED' } }))
      } else if (contentMode === 'expired' || contentMode === 'expire-once') {
        if (contentMode === 'expire-once') {
          contentMode = 'valid'
        }

        expired()
      } else {
        response.end('download bytes')
      }

      return
    }

    if (onRequest?.(route, response)) {
      return
    }

    response.setHeader('Content-Type', 'application/json')

    const data =
      route === '/unicom/FileDetails'
        ? { fid: 'one', fileName: 'report.txt' }
        : route === '/assets/download'
          ? { download_path: '/drive/content?fid=one' }
          : route === '/drive/capabilities'
            ? { upload: true }
            : { items: [] }

    response.end(JSON.stringify({ ok: true, status: 'succeeded', data }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  drive = new CloudDriveClient(
    () => identity,
    async (source, options) => {
      const url = new URL(String(source))
      const route = url.pathname.endsWith('/access-token') ? '/access-token' : url.pathname.split('/clouddrive/v1')[1]

      const response = await fetch(base + route + url.search, options)

      return onResponse ? onResponse(route, response) : response
    }
  )
  mcp = new CloudDriveMcp(drive, root, path.join(root, 'workspace'))
  expect(await mcp.prepare('default')).toBe(true)
  const config = parse(await readFile(path.join(root, 'config.yaml'), 'utf8')).mcp_servers[DRIVE_MCP_SERVER]
  endpoint = config.url
  authorization = config.headers.Authorization
})

afterEach(async () => {
  await mcp.close()
  upstream.closeAllConnections()
  await new Promise<void>(resolve => upstream.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
})

async function call(name: string, args = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })

  expect(response.status).toBe(200)
  const { result } = await response.json()

  return { ...result, data: JSON.parse(result.content[0].text) }
}

async function setDriveEnabled(enabled: boolean) {
  const file = path.join(root, 'config.yaml')
  const config = parse(await readFile(file, 'utf8'))
  config.mcp_servers[DRIVE_MCP_SERVER].enabled = enabled
  await writeFile(file, stringify(config))
}

it('GUI 与 MCP 共用恢复后的凭据；直接写入先只读续期，并发工具只获取一次新令牌', async () => {
  await drive.execute({ route: '/asset-spaces' })
  rejected = 'drive-1'
  const [made, listed] = await Promise.all([call('make_dir', { name: 'folder' }), call('list_files')])
  expect(made.data.ok).toBe(true)
  expect(listed.data.ok).toBe(true)
  expect(tokens).toBe(2)
  expect(calls.filter(c => c.route === '/folders')).toEqual([
    { route: '/folders', token: 'drive-2', authorization: 'Bearer login-a' }
  ])
  await drive.execute({ route: '/asset-spaces' })
  expect(calls.at(-1)?.token).toBe('drive-2')
  expect(JSON.stringify(made)).not.toMatch(/drive-2|login-a/)
})

it('预检仍被拒绝则不发送写入；预检后才过期也不重放写入', async () => {
  await drive.execute({ route: '/asset-spaces' })
  // New token is valid during preflight but rejected by the actual write.
  rejectWrites = true
  const result = await call('make_dir', { name: 'folder' })
  expect(result.data).toMatchObject({ ok: false, code: 'DRIVE_AUTH_EXPIRED' })
  expect(calls.filter(c => c.route === '/folders')).toHaveLength(1)
  expect(tokens).toBe(2)
  // The recovered token is then rejected during the next read; cooldown stops a renewal loop.
  rejected = 'drive-2'
  const next = await call('make_dir', { name: 'other' })
  expect(next.data.ok).toBe(false)
  expect(calls.filter(c => c.route === '/folders')).toHaveLength(1)
  expect(tokens).toBe(2)
})

it('下载文件流明确过期时自动恢复一次，成功后才向 MCP 返回实际文件', async () => {
  contentMode = 'expire-once'
  const result = await call('download', { asset_id: 'one', name: 'report.txt' })
  expect(result.data.ok).toBe(true)
  expect(await readFile(result.data.path, 'utf8')).toBe('download bytes')
  expect(tokens).toBe(2)
  expect(calls.filter(c => c.route === '/drive/content').map(c => c.token)).toEqual(['drive-1', 'drive-2'])
  await drive.execute({ route: '/assets' })
  expect(calls.at(-1)?.token).toBe('drive-2')
})

it('持续过期只恢复一次，普通权限拒绝不换令牌，也不返回下载路径', async () => {
  contentMode = 'expired'
  const expired = await call('download', { asset_id: 'one', name: 'report.txt' })
  expect(expired.data.ok).toBe(false)
  expect(expired.data).not.toHaveProperty('path')
  expect(tokens).toBe(2)
  expect(calls.filter(c => c.route === '/drive/content')).toHaveLength(2)
  contentMode = 'forbidden'
  const denied = await call('download', { asset_id: 'one', name: 'report.txt' })
  expect(denied.data.ok).toBe(false)
  expect(denied.data).not.toHaveProperty('path')
  expect(tokens).toBe(2)
  expect(calls.filter(c => c.route === '/drive/content')).toHaveLength(3)
})

it('GUI 与 MCP 在账号 A→B→A 后分别获取凭据，不把 B 的令牌留给 A', async () => {
  await drive.execute({ route: '/asset-spaces' })
  identity = { ...identity, uid: 'b', token: 'login-b' }
  expect((await call('make_dir', { name: 'b-folder' })).data.ok).toBe(true)
  identity = { ...identity, uid: 'a', token: 'login-a' }
  expect((await call('make_dir', { name: 'a-folder' })).data.ok).toBe(true)
  expect(calls.filter(c => c.route === '/folders')).toEqual([
    { route: '/folders', token: 'drive-2', authorization: 'Bearer login-b' },
    { route: '/folders', token: 'drive-3', authorization: 'Bearer login-a' }
  ])
})

it.each([
  ['make_dir', { name: 'folder' }],
  ['rename_file', { asset_id: 'one', new_name: 'new.txt', kind: 'file' }],
  ['move_files', { file_ids: ['one'], target_parent_asset_id: 'folder' }],
  ['delete_files', { file_ids: ['one'] }],
  ['restore_files', { delete_nos: ['deleted-one'] }]
])('%s 的只读预检无法恢复时，不发送写请求', async (name, args) => {
  rejectProbes = true
  const result = await call(name, args)
  expect(result.data).toMatchObject({ ok: false, code: 'DRIVE_AUTH_EXPIRED' })
  expect(tokens).toBe(2)
  expect(calls.map(c => c.route)).toEqual(['/access-token', '/assets', '/access-token', '/assets'])
})

it('上传在首个分片前只读恢复提前作废的令牌，分片只发送一次', async () => {
  await writeFile(path.join(root, 'workspace', 'upload.txt'), 'upload bytes')
  await drive.execute({ route: '/asset-spaces' })
  rejected = 'drive-1'
  const result = await call('upload', { source_path: 'upload.txt' })
  expect(result.data).toMatchObject({ ok: true, name: 'upload.txt' })
  expect(tokens).toBe(2)
  expect(calls.filter(c => c.route === '/drive/upload-part')).toEqual([
    { route: '/drive/upload-part', token: 'drive-2', authorization: 'Bearer login-a' }
  ])
})

it('文件流续期期间切换账号后停止下载，不拿新账号身份重试旧文件', async () => {
  contentMode = 'expire-once'

  onAcquire = () => {
    if (tokens === 2) {
      identity = { ...identity, uid: 'b', token: 'login-b' }
    }
  }

  const result = await call('download', { asset_id: 'one', name: 'report.txt' })
  expect(result.data).toMatchObject({ ok: false, code: 'AUTH_CHANGED' })
  expect(result.data).not.toHaveProperty('path')
  expect(calls.filter(c => c.route === '/drive/content')).toHaveLength(1)
  expect(calls.some(c => c.authorization === 'Bearer login-b')).toBe(false)
})

it('关闭权限保留已收到的真实写入回执和批量部分成功，不重放写请求', async () => {
  await writeFile(path.join(root, 'workspace', 'upload.txt'), 'upload bytes')

  for (const [name, args, target, receipt] of [
    ['make_dir', { name: 'folder' }, '/folders', 'success'],
    ['rename_file', { asset_id: 'one', new_name: 'new.txt', kind: 'file' }, '/assets/one', 'success'],
    ['move_files', { file_ids: ['one'], target_parent_asset_id: 'folder' }, '/assets/move', 'success'],
    ['delete_files', { file_ids: ['one'] }, '/assets/trash', 'success'],
    ['restore_files', { delete_nos: ['deleted-one'] }, '/unicom/ReductionRecycleData', 'success'],
    ['upload', { source_path: 'upload.txt' }, '/drive/upload-part', 'success'],
    ['make_dir', { name: 'denied' }, '/folders', 'failed'],
    [
      'delete_files',
      { mode: 'purge', delete_nos: ['confirmed', 'denied', 'untouched'] },
      '/unicom/DeleteRecycleData',
      'partial'
    ]
  ] as const) {
    await setDriveEnabled(true)
    calls = []
    const expectedWrites = receipt === 'partial' ? 2 : 1
    const writes = () => calls.filter(c => c.route === target).length

    onRequest = (route, response) => {
      if (route !== target || receipt === 'success' || writes() !== expectedWrites) {
        return false
      }

      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          ok: false,
          status: 'failed',
          error: { code: 'PERMISSION_DENIED' }
        })
      )

      return true
    }

    onResponse = async (route, response) => {
      if (route !== target || writes() !== expectedWrites) {
        return response
      }

      // 已通过真实 HTTP 收完回执；随后关闭权限，模拟回执交付与配置更新相邻发生。
      const bytes = await response.arrayBuffer()
      await setDriveEnabled(false)

      return new Response(bytes, {
        status: response.status,
        headers: response.headers
      })
    }

    const result = await call(name, args)
    expect(mcp.available('default')).toBe(false)
    expect(writes()).toBe(expectedWrites)

    if (receipt === 'success') {
      expect(result.isError).not.toBe(true)
      expect(result.data).toMatchObject({ ok: true })

      if (name === 'upload') {
        expect(result.data).toMatchObject({
          status: 'succeeded',
          name: 'upload.txt'
        })
      } else {
        expect(result.data.data).toEqual({ items: [] })
      }
    } else {
      expect(result.isError).toBe(true)
      expect(result.data).toMatchObject({
        ok: false,
        status: receipt === 'partial' ? 'partial_success' : 'failed',
        code: 'PERMISSION_DENIED'
      })

      if (receipt === 'partial') {
        expect(result.data.item_results).toEqual([
          { delete_no: 'confirmed', status: 'succeeded' },
          { delete_no: 'denied', status: 'failed', code: 'PERMISSION_DENIED' },
          { delete_no: 'untouched', status: 'not_started' }
        ])
      }
    }

    const count = calls.length
    expect((await call('make_dir', { name: 'blocked' })).data.code).toBe('DRIVE_ACCESS_DISABLED')
    expect(calls).toHaveLength(count)
  }
})

it('关闭权限拒绝预检和读取，在途写入保留无法确认结果及批量进度，不重试剩余写入', async () => {
  for (const [name, args, target, expectedWrites, phase] of [
    ['make_dir', { name: 'preflight' }, '/assets', 1, 'preflight'],
    ['list_files', {}, '/assets', 1, 'read'],
    ['make_dir', { name: 'pending' }, '/folders', 1, 'write'],
    [
      'delete_files',
      { mode: 'purge', delete_nos: ['confirmed', 'pending', 'untouched'] },
      '/unicom/DeleteRecycleData',
      2,
      'write'
    ]
  ] as const) {
    await setDriveEnabled(true)
    calls = []
    let sent!: () => void

    const arrived = new Promise<void>(resolve => {
      sent = resolve
    })

    onRequest = route => {
      if (route !== target || calls.filter(c => c.route === target).length !== expectedWrites) {
        return false
      }

      // 请求已到真实上游；保持连接，等待权限监视器取消，不生成虚假的失败回执。
      sent()

      return true
    }

    const pending = call(name, args)
    await arrived
    await setDriveEnabled(false)
    const result = await pending

    if (phase === 'write') {
      expect(result.isError).not.toBe(true)
      expect(result.data).toMatchObject({
        ok: false,
        status: 'outcome_unknown'
      })
      expect(result.data.code).not.toBe('DRIVE_ACCESS_DISABLED')
    } else {
      expect(result.isError).toBe(true)
      expect(result.data).toMatchObject({
        ok: false,
        code: 'DRIVE_ACCESS_DISABLED'
      })
      expect(calls.some(c => c.route === '/folders')).toBe(false)
    }

    expect(calls.filter(c => c.route === target)).toHaveLength(expectedWrites)

    if (name === 'delete_files') {
      expect(result.data.item_results).toEqual([
        { delete_no: 'confirmed', status: 'succeeded' },
        {
          delete_no: 'pending',
          status: 'outcome_unknown',
          code: 'OPERATION_CONFIRMATION_UNAVAILABLE'
        },
        { delete_no: 'untouched', status: 'not_started' }
      ])
      expect(result.data.summary).toEqual({ succeeded: 1, total: 3 })
    }

    const count = calls.length
    expect((await call('make_dir', { name: 'blocked' })).data.code).toBe('DRIVE_ACCESS_DISABLED')
    expect(calls).toHaveLength(count)
  }
})
