import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, expect, it } from 'vitest'

import { CloudDriveClient } from './cloud-drive'
import { executeDriveMcpAction } from './cloud-drive-mcp-actions'
import type { LoginIdentity } from './session'

let server: Server
let drive: CloudDriveClient
let identity: LoginIdentity
let requests: Array<{ route: string; method: string; body: unknown; authorization: string; driveToken: string }>
let respond: (route: string, method: string) => unknown
let tokens: number
const job = '1234567890abcdef1234567890abcdef'
const input = { query: '报告', page_no: 2, page_size: 20 }

beforeEach(async () => {
  requests = []
  tokens = 0
  identity = {
    uid: 'A',
    token: 'login-A',
    phone: '13800000000',
    maskedPhone: '138****0000',
    expiresAt: Date.now() + 60_000
  }
  respond = () => ({ ok: true, data: {} })
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []

    for await (const chunk of req) {
      chunks.push(chunk)
    }

    const body = Buffer.concat(chunks).toString()
    requests.push({
      route: req.url!,
      method: req.method!,
      body: body ? JSON.parse(body) : undefined,
      authorization: String(req.headers.authorization ?? ''),
      driveToken: String(req.headers['x-drive-access-token'] ?? '')
    })
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify(
        req.url === '/access-token'
          ? { meta: { code: '' }, result: { accessToken: `drive-${++tokens}` } }
          : respond(req.url!, req.method!)
      )
    )
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  drive = new CloudDriveClient(
    () => identity,
    (source, options) => {
      const target = String(source)
      const route = target.endsWith('/access-token') ? '/access-token' : target.split('/clouddrive/v1')[1]

      return fetch(base + route, options)
    }
  )
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

it('搜索在真实 HTTP 上续期读凭据并轮询，accepted 不能提前成为搜索结果', async () => {
  let submitted = 0

  respond = (route, method) => {
    if (route === '/assets/search' && method === 'POST') {
      return submitted++ === 0
        ? { ok: false, error: { code: 'DRIVE_AUTH_EXPIRED' } }
        : { ok: true, status: 'accepted', data: { state: 'running', search_id: job } }
    }

    return {
      ok: true,
      status: 'succeeded',
      data: { items: [{ asset_id: 'report', name: '报告.txt' }], page: { page_no: 2, page_size: 20 } }
    }
  }

  const result = await executeDriveMcpAction(drive, 'filesearch', input, new AbortController().signal)
  expect(result).toMatchObject({
    items: [{ asset_id: 'report' }],
    page: { page_no: input.page_no, page_size: input.page_size }
  })
  expect(tokens).toBe(2)
  const calls = requests.filter(call => call.route !== '/access-token')
  expect(calls.map(call => call.method)).toEqual(['POST', 'POST', 'GET'])
  expect(calls[0].body).toEqual(input)
  expect(calls[0].driveToken).not.toBe(calls[1].driveToken)
  expect(calls[2]).toMatchObject({
    route: `/assets/search/${job}?page_no=2&page_size=20`,
    authorization: 'Bearer login-A',
    driveToken: calls[1].driveToken
  })
})

it('取消会清理自己的搜索，账号 A→B→A 不跨身份轮询、取消或复用云盘令牌', async () => {
  let accepted: () => void

  respond = (route, method) => {
    if (route.startsWith('/assets/search') && method !== 'DELETE') {
      if (method === 'GET') {
        accepted?.()
      }

      return { ok: true, status: 'accepted', data: { state: 'running', search_id: job } }
    }

    return { ok: true, data: {} }
  }

  const caller = new AbortController()
  const first = executeDriveMcpAction(drive, 'filesearch', input, caller.signal)
  await new Promise<void>(resolve => {
    accepted = resolve
  })
  caller.abort()
  await expect(first).rejects.toThrow()
  expect(requests.filter(call => call.method === 'DELETE')).toMatchObject([
    { route: `/assets/search/${job}`, authorization: 'Bearer login-A' }
  ])

  const switched = executeDriveMcpAction(drive, 'filesearch', input, new AbortController().signal)
  await new Promise<void>(resolve => {
    accepted = resolve
  })
  identity = { ...identity, uid: 'B', token: 'login-B' }
  await expect(switched).rejects.toThrow()
  expect(requests.filter(call => call.method === 'DELETE')).toHaveLength(1)
  expect(requests.some(call => call.authorization === 'Bearer login-B')).toBe(false)

  identity = { ...identity, uid: 'A', token: 'login-A-new' }
  const lastCaller = new AbortController()
  const restored = executeDriveMcpAction(drive, 'filesearch', input, lastCaller.signal)
  await new Promise<void>(resolve => {
    accepted = resolve
  })
  lastCaller.abort()
  await expect(restored).rejects.toThrow()
  const posts = requests.filter(call => call.route === '/assets/search')
  expect(posts.at(-1)!.authorization).toBe('Bearer login-A-new')
  expect(posts.at(-1)!.driveToken).not.toBe(posts[0].driveToken)
  expect(requests.filter(call => call.method === 'DELETE').at(-1)!.authorization).toBe('Bearer login-A-new')
}, 15_000)

it('MCP 单页列表和回收站对短页继续提示翻页，空页才结束；错误响应及页码超限不能伪装成完整目录', async () => {
  const assets = [
    { asset_id: 'one', name: 'one.txt', kind: 'file' },
    { asset_id: 'two', name: 'two.txt', kind: 'file' }
  ]

  let malformed = false

  respond = route => {
    const url = new URL(route, 'http://local')

    const page =
      url.pathname === '/assets'
        ? Number(url.searchParams.get('page_no'))
        : Number((requests.at(-1)?.body as { pageNo: number }).pageNo)

    const rows = assets.slice(page - 1, page)

    return {
      ok: true,
      data: malformed
        ? { page: { has_more: false } }
        : url.pathname === '/assets'
          ? { items: rows, page: { has_more: false } }
          : rows.map(row => ({ deleteNo: `deleted-${row.asset_id}`, name: row.name, type: '1' }))
    }
  }

  for (const name of ['list_files', 'list_recycle_bin']) {
    const collected: unknown[] = []

    for (const page of [1, 2, 3]) {
      const result = (await executeDriveMcpAction(
        drive,
        name,
        { page_no: page, page_size: 50, space_id: 'personal', parent_asset_id: '0' },
        new AbortController().signal
      )) as { items: unknown[]; page: Record<string, unknown> }

      collected.push(...result.items)
      expect(result.page).toMatchObject({
        page_no: page,
        page_size: 50,
        has_more: page < 3,
        end_reached: page === 3,
        next_page_no: page < 3 ? page + 1 : null
      })
    }

    expect(collected).toHaveLength(2)
  }

  malformed = true
  await expect(
    executeDriveMcpAction(drive, 'list_files', { page_no: 1 }, new AbortController().signal)
  ).rejects.toMatchObject({ result: { code: 'INVALID_RESPONSE' } })
  respond = () => ({ ok: true, data: { items: [], page: { has_more: true } } })
  await expect(
    executeDriveMcpAction(drive, 'list_files', { page_no: 1 }, new AbortController().signal)
  ).rejects.toMatchObject({ result: { code: 'INCOMPLETE_LISTING' } })
  respond = () => ({ ok: true, data: { items: assets, page: { has_more: false } } })
  await expect(
    executeDriveMcpAction(drive, 'list_files', { page_no: 1_000_000 }, new AbortController().signal)
  ).rejects.toMatchObject({ result: { code: 'INCOMPLETE_LISTING' } })
})
