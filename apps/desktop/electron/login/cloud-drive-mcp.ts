import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { isCurrentDriveMcpConfig, prepareDriveMcpConfig } from '../entry_local/drive-mcp-config'
import { resolveReadableFileForIpc } from '../hardening'

import type { CloudDriveClient } from './cloud-drive'
import { CloudDriveOperationError } from './cloud-drive'
import { driveFileName, executeDriveMcpAction } from './cloud-drive-mcp-actions'
import { DRIVE_MCP_TOOLS, type DriveMcpInput, parseDriveMcpInput } from './cloud-drive-mcp-tools'
import { CloudDriveTransfers } from './cloud-drive-transfers'
import { DRIVE_MCP_SERVER } from './drive-mcp-contract'

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
// 空间和 capabilities 只返回本地元数据；必须实际读取联通目录才能发现提前作废的令牌。
const CREDENTIAL_PROBE = '/assets?space_id=personal&parent_asset_id=0&page_no=1&page_size=1'

/** MCP 服务只监听回环，独立随机凭证仅授权当前账号云盘，不暴露 MaaS 凭据。 */
export class CloudDriveMcp {
  private server: Server | null = null
  private starting: Promise<string> | null = null
  private readonly token = randomBytes(32).toString('base64url')
  private closed = false
  private endpoint = ''
  private nextOwner = -1
  private readonly calls = new Set<AbortController>()
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

  /** 退出时停止在途操作和连接，磁盘上的短期 MCP 凭证随服务关闭失效。 */
  async close(): Promise<void> {
    this.closed = true

    for (const call of this.calls) {
      call.abort()
    }

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

        if (size > 256 * 1024) {
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
        result = { tools: DRIVE_MCP_TOOLS }
      } else if (message.method === 'tools/call') {
        result = await this.call(message.params?.name, message.params?.arguments ?? {}, response)
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
  private failure(code: string, status = 'failed') {
    return this.result({ ok: false, status, code }, true)
  }

  /** 工具保留上游业务状态，无法确认与明确执行失败分开呈现。 */
  private result(data: unknown, isError = false) {
    // 无法确认是已结束的业务结果，不渲染成工具执行失败；ok/status 仍明确禁止认作成功。
    const unconfirmed = !!data && typeof data === 'object' && 'status' in data && data.status === 'outcome_unknown'

    return {
      ...(isError && !unconfirmed ? { isError: true } : {}),
      content: [{ type: 'text', text: JSON.stringify(data) }]
    }
  }

  /** 并发、取消与身份检查覆盖所有工具，切换账号后不再继续轮询或发送文件。 */
  private async call(name: unknown, args: unknown, response: ServerResponse) {
    if (typeof name !== 'string' || !DRIVE_MCP_TOOLS.some(tool => tool.name === name) || this.calls.size >= 4) {
      return this.failure('TOOL_UNAVAILABLE')
    }

    const input = parseDriveMcpInput(name, args)

    if (!input) {
      return this.failure('INVALID_ARGUMENT')
    }

    const controller = new AbortController()
    const cancel = () => controller.abort()
    const check = this.drive.guardIdentity()

    const monitor = setInterval(() => {
      try {
        check()
      } catch {
        cancel()
      }
    }, 250)

    this.calls.add(controller)
    response.once('close', cancel)

    try {
      check()
      controller.signal.throwIfAborted()

      if (['make_dir', 'rename_file', 'move_files', 'delete_files', 'restore_files'].includes(name)) {
        // GUI 先加载目录，MCP 可直接写入；先用同一只读入口恢复被提前作废的凭据，不重放写请求。
        await this.drive.execute({ route: CREDENTIAL_PROBE }, controller.signal)
        check()
        controller.signal.throwIfAborted()
      }

      const transfers: Record<string, () => Promise<ReturnType<CloudDriveMcp['result']>>> = {
        download: () => this.download(input, controller.signal),
        upload: () => this.upload(input, controller.signal)
      }

      if (Object.hasOwn(transfers, name)) {
        return await transfers[name]()
      }

      const data = await executeDriveMcpAction(this.drive, name, input, controller.signal)
      check()
      const failed = !!data && typeof data === 'object' && 'ok' in data && data.ok === false

      return this.result(failed ? data : { ok: true, data }, failed)
    } catch (error) {
      if (error instanceof CloudDriveOperationError) {
        return this.result(error.result, true)
      }

      return this.failure(controller.signal.aborted ? 'CANCELLED' : 'TOOL_FAILED')
    } finally {
      clearInterval(monitor)
      response.removeListener('close', cancel)
      this.calls.delete(controller)
    }
  }

  /** 下载到当前账号工作区的独占目录，只有完整成功才向 Agent 返回可读取路径。 */
  private async download(input: DriveMcpInput, signal: AbortSignal) {
    const owner = this.nextOwner--
    const id = randomUUID()
    const cancel = () => this.transfers.cancel(owner, id)
    const check = this.drive.guardIdentity()
    let directory: string | undefined
    let saved = false
    signal.addEventListener('abort', cancel, { once: true })

    try {
      check()
      const workspace = await lstat(this.workspace)

      if (!workspace.isDirectory() || workspace.isSymbolicLink()) {
        return this.failure('INVALID_WORKSPACE')
      }

      const name =
        input.name ??
        driveFileName(
          await this.drive.execute(
            { route: '/unicom/FileDetails', method: 'POST', body: { fileId: input.asset_id } },
            signal
          )
        )

      if (
        typeof name !== 'string' ||
        !name.trim() ||
        name.length > 255 ||
        name === '.' ||
        name === '..' ||
        /[\\/:]/.test(name) ||
        Array.from(name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      ) {
        return this.failure('INVALID_NAME')
      }

      check()
      signal.throwIfAborted()

      const root = path.join(this.workspace, '.uniwork-drive')
      await mkdir(root, { recursive: true, mode: 0o700 })
      const stat = await lstat(root)

      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return this.failure('INVALID_WORKSPACE')
      }

      directory = await mkdtemp(path.join(root, 'file-'))
      const destination = path.join(directory, name)

      const result = await this.transfers.run(
        owner,
        { id, operation: 'download', assetId: String(input.asset_id), name },
        {
          selectUpload: async () => null,
          selectDownload: async () => {
            check()

            return signal.aborted ? null : destination
          },
          progress: () => {}
        }
      )

      if (result.status !== 'succeeded') {
        return 'code' in result ? this.result(result, true) : this.failure('CANCELLED')
      }

      check()
      saved = true

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, asset_id: input.asset_id, name, path: destination })
          }
        ]
      }
    } finally {
      signal.removeEventListener('abort', cancel)

      if (directory && !saved) {
        await rm(directory, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  /** 上传复用原生分片传输和敏感文件策略，文件替换由已授权快照校验。 */
  private async upload(input: DriveMcpInput, signal: AbortSignal) {
    const check = this.drive.guardIdentity()
    let file

    try {
      file = await resolveReadableFileForIpc(String(input.source_path), {
        baseDir: this.workspace,
        purpose: 'Cloud drive upload'
      })
    } catch {
      return this.failure('LOCAL_FILE_READ_FAILED')
    }

    check()
    signal.throwIfAborted()
    // 本地文件通过原有授权检查后，再用只读请求恢复凭据；无效或敏感文件不发起网络请求。
    await this.drive.execute({ route: CREDENTIAL_PROBE }, signal)
    check()
    signal.throwIfAborted()
    const owner = this.nextOwner--
    const id = randomUUID()
    const cancel = () => this.transfers.cancel(owner, id)
    signal.addEventListener('abort', cancel, { once: true })

    try {
      const { dev, ino, size, mtimeMs, ctimeMs } = file.stat

      const result = await this.transfers.run(
        owner,
        { id, operation: 'upload', parentAssetId: String(input.parent_asset_id) },
        {
          selectUpload: async () => {
            check()

            return signal.aborted
              ? null
              : {
                  path: file.realPath,
                  name: path.basename(file.realPath),
                  snapshot: { dev, ino, size, mtimeMs, ctimeMs }
                }
          },
          selectDownload: async () => null,
          progress: () => {}
        }
      )

      check()

      return result.status === 'succeeded'
        ? this.result({ ok: true, status: result.status, name: result.name, parent_asset_id: input.parent_asset_id })
        : 'code' in result
          ? this.result(result, true)
          : this.failure('CANCELLED')
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }
}
