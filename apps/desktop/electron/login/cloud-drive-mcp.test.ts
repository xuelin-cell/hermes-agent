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
      : String(source).endsWith('/unicom/FileDetails')
        ? Response.json({ ok: true, data: { fid: 'one' } })
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
  expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['download'])
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
        body: 'x'.repeat(9000)
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
  expect(JSON.parse(result.result.content[0].text)).toEqual({ ok: false, code: 'INVALID_WORKSPACE' })
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
    expect(result).toMatchObject({ tools: ['download'], error: false, data: { ok: true } })
    expect(await readFile(result.data.path, 'utf8')).toBe('hello')
  },
  15_000
)
