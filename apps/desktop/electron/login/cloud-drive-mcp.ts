import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { isCurrentDriveMcpConfig, prepareDriveMcpConfig } from '../entry_local/drive-mcp-config'

import type { CloudDriveClient } from './cloud-drive'
import { CloudDriveTransfers } from './cloud-drive-transfers'
import { DRIVE_MCP_SERVER, DRIVE_MCP_TOOL } from './drive-mcp-contract'

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const TOOL = {
  name: DRIVE_MCP_TOOL,
  description:
    '下载当前 UniWork 桌面账号的云盘文件。用户消息包含云盘文件 ID 时，先调用此工具，再读取返回的本机 path；不要猜测内容或把桌面预览路径当成远程路径。仅适用于与桌面同机的 Hermes。',
  inputSchema: {
    type: 'object',
    properties: {
      asset_id: { type: 'string', minLength: 1, maxLength: 512 },
      name: { type: 'string', minLength: 1, maxLength: 255 }
    },
    required: ['asset_id', 'name'],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
}

/** MCP 服务只监听回环，独立随机凭证仅授权当前账号云盘，不暴露 MaaS 凭据。 */
export class CloudDriveMcp {
  private server: Server | null = null
  private starting: Promise<string> | null = null
  private readonly token = randomBytes(32).toString('base64url')
  private closed = false
  private endpoint = ''
  private nextOwner = -1
  private running = 0
  private readonly transfers: CloudDriveTransfers

  /** 目录由可信账号运行时提供，工具参数不能选择写入目录或下载 URL。 */
  constructor(
    private readonly drive: CloudDriveClient,
    private readonly home: string,
    private readonly workspace: string
  ) {
    this.transfers = new CloudDriveTransfers(drive, path.join(workspace, '.uniwork-drive-preview'))
  }

  /** 每个本地 Profile 后端启动前安装记录；配置异常不阻断聊天启动。 */
  async prepare(profile: string): Promise<boolean> {
    try {
      const url = await this.start()

      if (this.closed) {
        return false
      }

      return prepareDriveMcpConfig(this.home, profile || 'default', url, this.token)
    } catch {
      return false
    }
  }

  /** 页面只得到可用性，不得到端口、短期 MCP 密钥或账号凭据。 */
  available(profile: string): boolean {
    return (
      !this.closed &&
      !!this.endpoint &&
      isCurrentDriveMcpConfig(this.home, profile || 'default', this.endpoint, this.token)
    )
  }

  /** 一次启动复用同一端口，便于多个本地 Profile 共享当前账号的认证缓存。 */
  private start(): Promise<string> {
    if (this.closed) {
      return Promise.reject(new Error('Drive MCP closed'))
    }

    this.starting ??= new Promise<string>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request, response)
      })

      this.server = server
      server.headersTimeout = 10_000
      server.requestTimeout = 15_000
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port
        this.endpoint = `http://127.0.0.1:${port}/mcp`
        resolve(this.endpoint)
      })
    })

    return this.starting
  }

  /** 退出时停止所有下载和连接，磁盘上的短期 MCP 凭证随服务关闭失效。 */
  async close(): Promise<void> {
    this.closed = true
    this.transfers.cancelAll()
    const server = this.server

    if (!server) {
      return
    }

    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    this.server = null
  }

  /** 固定 JSON 响应不包含调用栈、上游错误原文和认证信息。 */
  private reply(response: ServerResponse, status: number, body?: unknown): void {
    if (response.destroyed) {
      return
    }

    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(body === undefined ? undefined : JSON.stringify(body))
  }

  /** 最小无状态 Streamable HTTP 协议；不接受浏览器来源、任意 Host 或未认证请求。 */
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const address = this.server?.address() as AddressInfo | null
      const supplied = Buffer.from(request.headers.authorization || '')
      const expected = Buffer.from(`Bearer ${this.token}`)

      if (
        this.closed ||
        !address ||
        request.url !== '/mcp' ||
        request.headers.host !== `127.0.0.1:${address.port}` ||
        request.headers.origin ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        this.reply(response, 403)

        return
      }

      if (request.method !== 'POST') {
        this.reply(response, 405)

        return
      }

      if (!request.headers['content-type']?.startsWith('application/json')) {
        this.reply(response, 415)

        return
      }

      const chunks: Buffer[] = []
      let size = 0

      for await (const chunk of request) {
        size += chunk.length

        if (size > 8192) {
          this.reply(response, 413)

          return
        }

        chunks.push(chunk)
      }

      let message

      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        this.reply(response, 400)

        return
      }

      if (
        !message ||
        Array.isArray(message) ||
        message.jsonrpc !== '2.0' ||
        typeof message.method !== 'string' ||
        (message.id !== undefined && typeof message.id !== 'number' && typeof message.id !== 'string')
      ) {
        this.reply(response, 400)

        return
      }

      if (message.id === undefined) {
        this.reply(response, 202)

        return
      }

      const envelope = { jsonrpc: '2.0', id: message.id }
      let result: unknown

      if (message.method === 'initialize') {
        result = {
          protocolVersion: VERSIONS.includes(message.params?.protocolVersion)
            ? message.params.protocolVersion
            : '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: DRIVE_MCP_SERVER, version: '1.0.0' }
        }
      } else if (message.method === 'ping') {
        result = {}
      } else if (message.method === 'tools/list') {
        result = { tools: [TOOL] }
      } else if (message.method === 'tools/call') {
        if (message.params?.name !== DRIVE_MCP_TOOL || this.running >= 4) {
          result = this.failure('TOOL_UNAVAILABLE')
        } else {
          result = await this.download(message.params.arguments, response)
        }
      } else {
        this.reply(response, 200, { ...envelope, error: { code: -32601, message: 'Method not found' } })

        return
      }

      this.reply(response, 200, { ...envelope, result })
    } catch {
      this.reply(response, 500)
    }
  }

  /** 业务失败作为 MCP 工具结果返回，模型不能将失败误读为已下载文件。 */
  private failure(code: string) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code }) }] }
  }

  /** 下载到当前账号工作区的独占目录，只有完整成功才向 Agent 返回可读取路径。 */
  private async download(args: unknown, response: ServerResponse) {
    const input = args as { asset_id?: unknown; name?: unknown } | null

    if (
      !input ||
      typeof input.asset_id !== 'string' ||
      !input.asset_id ||
      input.asset_id.length > 512 ||
      typeof input.name !== 'string' ||
      !input.name ||
      input.name.length > 255 ||
      path.basename(input.name) !== input.name ||
      /[\\/:]/.test(input.name) ||
      Object.keys(input).some(key => !['asset_id', 'name'].includes(key))
    ) {
      return this.failure('INVALID_ARGUMENT')
    }

    const owner = this.nextOwner--
    const id = randomUUID()
    const cancel = () => this.transfers.cancel(owner, id)
    const check = this.drive.guardIdentity()
    let directory: string | undefined
    let saved = false
    this.running++
    response.once('close', cancel)

    try {
      check()
      const workspace = await lstat(this.workspace)

      if (!workspace.isDirectory() || workspace.isSymbolicLink()) {
        return this.failure('INVALID_WORKSPACE')
      }

      const root = path.join(this.workspace, '.uniwork-drive')
      await mkdir(root, { recursive: true, mode: 0o700 })
      const stat = await lstat(root)

      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return this.failure('INVALID_WORKSPACE')
      }

      directory = await mkdtemp(path.join(root, 'file-'))
      const destination = path.join(directory, input.name)

      const result = await this.transfers.run(
        owner,
        { id, operation: 'download', assetId: input.asset_id, name: input.name },
        {
          selectUpload: async () => null,
          selectDownload: async () => {
            check()

            return response.destroyed ? null : destination
          },
          progress: () => {}
        }
      )

      if (result.status !== 'succeeded') {
        return this.failure('code' in result ? result.code : 'CANCELLED')
      }

      check()
      saved = true

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, asset_id: input.asset_id, name: input.name, path: destination })
          }
        ]
      }
    } catch {
      return this.failure('DOWNLOAD_FAILED')
    } finally {
      response.removeListener('close', cancel)
      this.running--

      if (directory && !saved) {
        await rm(directory, { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}
