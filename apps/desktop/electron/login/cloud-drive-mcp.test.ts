import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import { CloudDriveClient } from './cloud-drive'
import { CloudDriveMcp } from './cloud-drive-mcp'
import { DRIVE_MCP_SERVER } from './drive-mcp-contract'

let root: string
let mcp: CloudDriveMcp
let url: string
let authorization: string
let identity: { uid: string; token: string; phone: string; maskedPhone: string; expiresAt: number } | null
let request: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hermes-drive-mcp-'))
  const workspace = path.join(root, 'workspace')
  await mkdir(workspace)
  identity = {
    uid: 'user',
    token: 'private-login',
    phone: '13800000000',
    maskedPhone: '138****0000',
    expiresAt: Date.now() + 60_000
  }
  request = vi.fn<typeof fetch>(async source =>
    String(source).endsWith('access-token')
      ? Response.json({ meta: { code: '' }, result: { accessToken: 'private-drive' } })
      : new URL(String(source)).pathname.endsWith('/assets')
        ? Response.json({ ok: true, data: { items: [] } })
        : String(source).endsWith('/unicom/FileDetails')
          ? Response.json({ ok: true, data: { fid: 'one', fileName: '报告.txt' } })
          : String(source).endsWith('/assets/download')
            ? Response.json({ ok: true, data: { download_path: '/drive/content?fid=one' } })
            : new Response('hello')
  )
  mcp = new CloudDriveMcp(new CloudDriveClient(() => identity, request), root, workspace)
  expect(await mcp.prepare('default')).toBe(true)
  const config = parse(await readFile(path.join(root, 'config.yaml'), 'utf8')).mcp_servers[DRIVE_MCP_SERVER]
  url = config.url
  authorization = config.headers.Authorization
})

afterEach(async () => {
  await mcp.close()
  await rm(root, { recursive: true, force: true })
})

/** 通过实际回环 HTTP 测试 JSON-RPC 边界，不直接调用工具实现。 */
async function rpc(method: string, params?: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })

  expect(response.status).toBe(200)

  return await response.json()
}

it('握手与工具发现不下载，工具调用成功后才返回当前账号工作区路径', async () => {
  expect((await rpc('initialize', { protocolVersion: '2025-11-25' })).result).toMatchObject({
    protocolVersion: '2025-11-25',
    capabilities: { tools: {} }
  })
  const tools = await rpc('tools/list')
  expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
    expect.arrayContaining(['download', 'upload', 'filesearch'])
  )
  expect(request).not.toHaveBeenCalled()
  const result = await rpc('tools/call', { name: 'download', arguments: { asset_id: 'asset-one', name: '报告.txt' } })
  const data = JSON.parse(result.result.content[0].text)
  expect(data).toMatchObject({ ok: true, asset_id: 'asset-one', name: '报告.txt' })
  expect(data.path.startsWith(path.join(root, 'workspace', '.uniwork-drive') + path.sep)).toBe(true)
  expect(await readFile(data.path, 'utf8')).toBe('hello')
  expect(JSON.stringify(result)).not.toMatch(/private-login|private-drive/)
  const config = await readFile(path.join(root, 'config.yaml'), 'utf8')
  expect(config).not.toMatch(/private-login|private-drive/)
})

it('拒绝无凭证、其他 Origin、Host、超大请求及越界工具参数', async () => {
  expect((await fetch(url, { method: 'POST' })).status).toBe(403)
  expect(
    (await fetch(url, { method: 'POST', headers: { Authorization: authorization, Origin: 'https://foreign.invalid' } }))
      .status
  ).toBe(403)

  const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
    const call = httpRequest(
      url,
      { method: 'POST', headers: { Authorization: authorization, Host: 'foreign.invalid' } },
      response => {
        response.resume()
        resolve(response.statusCode)
      }
    )

    call.on('error', reject)
    call.end()
  })

  expect(foreignHost).toBe(403)
  expect(
    (
      await fetch(url, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: 'x'.repeat(256 * 1024 + 1)
      })
    ).status
  ).toBe(413)

  for (const name of ['../outside', 'C:\\private.txt', '..', '.']) {
    expect((await rpc('tools/call', { name: 'download', arguments: { asset_id: 'asset', name } })).result.isError).toBe(
      true
    )
  }

  expect(
    (
      await rpc('tools/call', {
        name: 'download',
        arguments: { asset_id: 'asset', name: 'safe.txt', path: '/outside' }
      })
    ).result.isError
  ).toBe(true)
  expect((await rpc('tools/call', { name: 'trash', arguments: {} })).result.isError).toBe(true)
  expect(request).not.toHaveBeenCalled()
})

it('退出身份后工具失败且不泄露旧文件，关闭服务后旧凭证失效', async () => {
  identity = null
  const result = await rpc('tools/call', { name: 'download', arguments: { asset_id: 'asset', name: 'safe.txt' } })
  expect(result.result.isError).toBe(true)
  expect(JSON.parse(result.result.content[0].text)).not.toHaveProperty('path')
  expect(request).not.toHaveBeenCalled()
  await mcp.close()
  await expect(fetch(url, { headers: { Authorization: authorization } })).rejects.toThrow()
  expect(await mcp.prepare('default')).toBe(false)
})

it('工作区被替换为符号链接时不下载，不把文件写到其他目录', async () => {
  const workspace = path.join(root, 'workspace')
  const elsewhere = path.join(root, 'elsewhere')
  await rm(workspace, { recursive: true })
  await mkdir(elsewhere)
  await symlink(elsewhere, workspace, process.platform === 'win32' ? 'junction' : 'dir')
  const result = await rpc('tools/call', { name: 'download', arguments: { asset_id: 'asset', name: 'safe.txt' } })
  expect(result.result.isError).toBe(true)
  expect(JSON.parse(result.result.content[0].text)).toMatchObject({ ok: false, code: 'INVALID_WORKSPACE' })
  expect(request).not.toHaveBeenCalled()
})

it('可用性只确认当前桌面自己的 MCP 端点，同名配置被改写后立即失效', async () => {
  expect(mcp.available('default')).toBe(true)
  expect(mcp.available('../default')).toBe(false)
  const file = path.join(root, 'config.yaml')
  const config = await readFile(file, 'utf8')
  await writeFile(file, config.replace(url, 'https://personal.invalid/mcp'))
  expect(mcp.available('default')).toBe(false)
  expect(request).not.toHaveBeenCalled()
})

it('发现的云盘动作走真实 MCP 和账号客户端，写入参数与上传字节一致，未知写入不重放', async () => {
  const original = request.getMockImplementation()!
  request.mockImplementation(async (source, options) => {
    const route = new URL(String(source)).pathname

    if (route.endsWith('/unicom/QueryRecycleData')) {
      return Response.json({ ok: true, data: [{ deleteNo: 'trash-one', name: 'old.txt', type: '1', fileSize: 5 }] })
    }

    if (route.endsWith('/drive/capabilities')) {
      return Response.json({ ok: true, data: { upload: true } })
    }

    if (route.endsWith('/drive/upload-part')) {
      return Response.json({ ok: true, status: 'succeeded', data: {} })
    }

    if (route.endsWith('/unicom/DeleteRecycleData') && String(options?.body).includes('unknown')) {
      throw new Error('connection interrupted')
    }

    if (
      /\/(assets|folders|usage|ReductionRecycleData|DeleteRecycleData|move|trash)$/.test(route) ||
      options?.method === 'PATCH'
    ) {
      return Response.json({
        ok: true,
        status: 'succeeded',
        data: route.endsWith('/assets') ? { items: [] } : { saved: true }
      })
    }

    return original(source, options)
  })
  const listed = (await rpc('tools/list')).result.tools.map((tool: { name: string }) => tool.name)

  const cases = [
    ['list_files', {}, '/assets', 'GET', undefined],
    ['make_dir', { name: '新目录' }, '/folders', 'POST', { parent_asset_id: '0', name: '新目录' }],
    [
      'rename_file',
      { asset_id: 'asset-one', new_name: '新名称.txt', kind: 'file' },
      '/assets/asset-one',
      'PATCH',
      { new_name: '新名称.txt', kind: 'file' }
    ],
    [
      'move_files',
      { file_ids: ['asset-one'], target_parent_asset_id: 'folder' },
      '/assets/move',
      'POST',
      { file_ids: ['asset-one'], directory_ids: [], target_parent_asset_id: 'folder' }
    ],
    [
      'delete_files',
      { file_ids: ['asset-one'] },
      '/assets/trash',
      'POST',
      { file_ids: ['asset-one'], directory_ids: [] }
    ],
    ['get_file_info', { asset_id: 'asset-one' }, '/unicom/FileDetails', 'POST', { fileId: 'asset-one' }],
    ['list_recycle_bin', {}, '/unicom/QueryRecycleData', 'POST', { pageNo: 1, pageSize: 50, sortRule: '0' }],
    [
      'restore_files',
      { delete_nos: ['trash-one'] },
      '/unicom/ReductionRecycleData',
      'POST',
      { deleteNos: ['trash-one'] }
    ],
    ['get_capacity', {}, '/asset-spaces/personal/usage', 'GET', undefined]
  ] as const

  for (const [name, args, route, method, body] of cases) {
    expect(listed).toContain(name)
    const result = (await rpc('tools/call', { name, arguments: args })).result
    expect(result.isError).not.toBe(true)
    const [source, options] = request.mock.calls.at(-1)!
    expect(new URL(String(source)).pathname.endsWith(route)).toBe(true)
    expect(options?.method).toBe(method)
    expect(options?.body ? JSON.parse(String(options.body)) : undefined).toEqual(body)

    if (name === 'list_files') {
      expect(new URL(String(source)).searchParams.get('space_id')).toBe('personal')
    }

    if (name === 'list_recycle_bin') {
      expect(JSON.parse(result.content[0].text).data.items[0]).toMatchObject({
        delete_no: 'trash-one',
        name: 'old.txt',
        kind: 'file',
        size_bytes: 5
      })
    }
  }

  const downloaded = JSON.parse(
    (await rpc('tools/call', { name: 'download', arguments: { asset_id: 'asset-one' } })).result.content[0].text
  )

  expect(await readFile(downloaded.path, 'utf8')).toBe('hello')
  expect(downloaded.name).toBe('报告.txt')
  const sourcePath = path.join(root, 'workspace', 'upload.txt')
  await writeFile(sourcePath, 'upload bytes')

  const uploaded = (
    await rpc('tools/call', { name: 'upload', arguments: { source_path: 'upload.txt', parent_asset_id: 'folder' } })
  ).result

  expect(JSON.parse(uploaded.content[0].text)).toMatchObject({
    ok: true,
    name: 'upload.txt',
    parent_asset_id: 'folder'
  })
  const [, upload] = request.mock.calls.find(([source]) => String(source).endsWith('/drive/upload-part'))!
  expect(Buffer.from(upload!.body as Uint8Array).toString()).toBe('upload bytes')
  expect(
    JSON.parse(Buffer.from((upload!.headers as Record<string, string>)['X-Drive-Upload-Metadata'], 'base64').toString())
  ).toMatchObject({ fileName: 'upload.txt', directoryId: 'folder', totalPart: 1 })

  const purged = (
    await rpc('tools/call', {
      name: 'delete_files',
      arguments: { mode: 'purge', delete_nos: ['confirmed', 'unknown', 'untouched'] }
    })
  ).result

  expect(purged.isError).not.toBe(true)
  expect(JSON.parse(purged.content[0].text)).toMatchObject({
    ok: false,
    status: 'outcome_unknown',
    item_results: [
      { delete_no: 'confirmed', status: 'succeeded' },
      { delete_no: 'unknown', status: 'outcome_unknown' },
      { delete_no: 'untouched', status: 'not_started' }
    ]
  })
  expect(request.mock.calls.filter(([source]) => String(source).endsWith('/unicom/DeleteRecycleData'))).toHaveLength(2)
  expect(JSON.stringify(purged)).not.toMatch(/private-login|private-drive|connection interrupted/)
})

it('批量工具拒绝跨空间、混用 ID、敏感文件和符号链接目标，不发送任何上游请求', async () => {
  for (const [name, args] of [
    ['list_files', { space_id: 'project' }],
    ['list_recycle_bin', { spaceType: 1 }],
    ['get_capacity', { token: 'external' }],
    ['move_files', { target_parent_asset_id: '0', file_ids: [] }],
    ['delete_files', { mode: 'purge', file_ids: ['file'], delete_nos: ['trash'] }],
    ['delete_files', { delete_nos: ['trash'] }],
    ['restore_files', { delete_nos: ['one', 'one'] }],
    ['filesearch', { query: ' ' }],
    ['list_files', { page_size: 201 }]
  ]) {
    expect((await rpc('tools/call', { name, arguments: args })).result.isError).toBe(true)
  }

  const sensitive = path.join(root, 'workspace', '.env')
  await writeFile(sensitive, 'secret')
  await symlink(sensitive, path.join(root, 'workspace', 'disguised.txt'))

  for (const source_path of ['.env', 'disguised.txt', 'https://untrusted.invalid/source']) {
    expect((await rpc('tools/call', { name: 'upload', arguments: { source_path } })).result.isError).toBe(true)
  }

  expect(request).not.toHaveBeenCalled()
})

it.skipIf(!process.env.HERMES_DRIVE_MCP_TEST_PYTHON)(
  '与 Hermes 安装的真实 Python MCP SDK 完成握手、发现及文件下载',
  async () => {
    const script = `import asyncio,json,sys
from mcp import ClientSession
from mcp.client import streamable_http as transport
async def main():
    async with transport.httpx2.AsyncClient(headers={"Authorization":sys.argv[2]},trust_env=False) as client:
        async with transport.streamable_http_client(sys.argv[1],http_client=client) as streams:
            read,write=streams[:2]
            async with ClientSession(read,write) as session:
                await session.initialize()
                tools=await session.list_tools()
                result=await session.call_tool("download",{"asset_id":"asset-one","name":"sdk.txt"})
                print(json.dumps({"tools":[t.name for t in tools.tools],"data":json.loads(result.content[0].text),"error":getattr(result,"is_error",getattr(result,"isError",False))}))
asyncio.run(main())`

    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        process.env.HERMES_DRIVE_MCP_TEST_PYTHON!,
        ['-c', script, url, authorization],
        { timeout: 10_000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                'MCP SDK client failed: ' + stderr.replaceAll(authorization, '[redacted]').replaceAll(root, '[fixture]')
              )
            )
          } else {
            resolve(stdout)
          }
        }
      )
    })

    const result = JSON.parse(output)
    expect(result).toMatchObject({ error: false, data: { ok: true } })
    expect(result.tools).toContain('download')
    expect(await readFile(result.data.path, 'utf8')).toBe('hello')
  },
  15_000
)
