import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'

import { writeSecretFileAtomic } from '../hardening'

import { CONNECTOR_SPECS, type ConnectorId, type LocalConnectorRow } from './contract'

interface RuntimeSecrets {
  encryption: string
  admin: string
  runtime: string
}
export interface ConnectorRuntimeOptions {
  directory: string
  runtimeDirectory: string
  executable: string
  encrypt: (value: string) => Buffer
  decrypt: (value: Buffer) => string
}

/** 独立 Node 服务持有第三方凭据；每个 Profile 单独启动、加密和退出。 */
export class ConnectorRuntime {
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private origin = ''
  private secrets: RuntimeSecrets | null = null
  private closed = false

  constructor(private readonly options: ConnectorRuntimeOptions) {}

  /** 只发布绑定本 Profile 的运行时令牌，管理令牌始终留在主进程。 */
  async config(id: ConnectorId): Promise<Record<string, unknown>> {
    await this.start()

    return {
      url: `${this.origin}/mcp`,
      headers: { Authorization: `Bearer ${this.secrets!.runtime}`, 'X-OpenConnector-Allowed-Services': id },
      desktop_connector: id,
      timeout: 600
    }
  }

  /** 合并同时到来的探活请求；退出后不允许迟到请求重新拉起服务。 */
  start(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('连接器服务已关闭。'))
    }

    this.starting ??= this.launch().catch(error => {
      this.starting = null
      throw error
    })

    return this.starting
  }

  /** 系统加密保存密钥，数据库和账号授权不从 HexAgent 复制。 */
  private readSecrets(): RuntimeSecrets {
    fs.mkdirSync(this.options.directory, { recursive: true, mode: 0o700 })

    for (const name of ['secrets.enc', 'connect.sqlite', 'connect.sqlite-wal', 'connect.sqlite-shm']) {
      const stat = fs.lstatSync(path.join(this.options.directory, name), { throwIfNoEntry: false })

      if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
        throw new Error('Invalid connector storage file')
      }
    }

    const file = path.join(this.options.directory, 'secrets.enc')

    if (fs.existsSync(file)) {
      const value = JSON.parse(this.options.decrypt(fs.readFileSync(file))) as RuntimeSecrets

      if (
        ![value.encryption, value.admin, value.runtime].every(
          item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)
        )
      ) {
        throw new Error('连接器密钥文件无效。')
      }

      return value
    }

    const value = {
      encryption: randomBytes(32).toString('hex'),
      admin: randomBytes(32).toString('hex'),
      runtime: randomBytes(32).toString('hex')
    }

    writeSecretFileAtomic(file, this.options.encrypt(JSON.stringify(value)))

    return value
  }

  /** 先保留随机回环端口再启动，不接管本机其他程序或旧账号服务。 */
  private async launch(): Promise<void> {
    const entry = path.join(this.options.runtimeDirectory, 'src', 'server', 'index.ts')

    if (!fs.existsSync(entry) || !fs.existsSync(path.join(this.options.runtimeDirectory, 'node_modules', 'hono'))) {
      throw new Error('连接器运行时未准备，请先安装 OpenConnector 运行依赖。')
    }

    this.secrets = this.readSecrets()

    const port = this.origin
      ? Number(new URL(this.origin).port)
      : await new Promise<number>((resolve, reject) => {
          const reservation = createServer()
          reservation.once('error', reject)
          reservation.listen(0, '127.0.0.1', () => {
            const address = reservation.address()

            if (!address || typeof address === 'string') {
              reservation.close()
              reject(new Error('连接器端口不可用。'))

              return
            }

            reservation.close(() => resolve(address.port))
          })
        })

    if (this.closed) {
      throw new Error('连接器服务已关闭。')
    }

    this.origin = `http://127.0.0.1:${port}`
    // 不继承旧进程里的 Provider token、数据库地址或第三方运行配置。
    const env: NodeJS.ProcessEnv = {}

    for (const key of [
      'SystemRoot',
      'WINDIR',
      'PATH',
      'PATHEXT',
      'TEMP',
      'TMP',
      'HOME',
      'USERPROFILE',
      'LOCALAPPDATA',
      'APPDATA'
    ]) {
      if (process.env[key]) {
        env[key] = process.env[key]
      }
    }

    Object.assign(env, {
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      OOMOL_CONNECT_DATA_DIR: this.options.directory,
      OOMOL_CONNECT_ORIGIN: this.origin,
      OOMOL_CONNECT_ENCRYPTION_KEY: this.secrets.encryption,
      OOMOL_CONNECT_ADMIN_TOKEN: this.secrets.admin,
      OOMOL_CONNECT_RUNTIME_TOKEN: this.secrets.runtime,
      OOMOL_CONNECT_MCP_ALLOWED_SERVICES: Object.keys(CONNECTOR_SPECS).join(',')
    })

    const child = spawn(
      this.options.executable,
      ['--experimental-transform-types', path.join(this.options.runtimeDirectory, 'desktop-entry.mjs')],
      { cwd: this.options.runtimeDirectory, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
    )

    this.child = child
    let exited = false
    child.once('error', () => {
      exited = true
    })
    child.once('exit', () => {
      exited = true

      if (this.child === child) {
        this.child = null
        this.starting = null
      }
    })
    // 排空 stderr，避免管道阻塞；不把可能含第三方信息的原文返回 Renderer。
    child.stderr?.resume()
    const deadline = Date.now() + 20_000

    while (Date.now() < deadline && !this.closed && !exited) {
      try {
        const response = await fetch(`${this.origin}/health`, { signal: AbortSignal.timeout(1000) })

        if (response.ok) {
          return
        }
      } catch {
        /* 进程启动期间端口尚未就绪，继续有界探活。 */
      }

      await new Promise(resolve => setTimeout(resolve, 150))
    }

    child.kill()
    throw new Error('连接器服务启动失败，请检查 OpenConnector 依赖和 Node 运行环境。')
  }

  /** 固定管理 API 仅由本模块内部选择，不接受 Renderer 提供的地址。 */
  async request(route: string, method = 'GET', body?: unknown): Promise<any> {
    await this.start()

    const response = await fetch(`${this.origin}${route}`, {
      method,
      headers: { Authorization: `Bearer ${this.secrets!.admin}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000)
    })

    if (!response.ok) {
      // 上游响应可能包含凭据，不直接向页面透传。
      throw new Error(
        response.status === 400 ? '连接器拒绝了连接，请核对凭据或授权设置。' : '连接器服务请求失败，请稍后重试。'
      )
    }

    return response.json()
  }

  /** 只返回是否已经配置，不把账号标识或凭据转发给页面。 */
  async rows(): Promise<LocalConnectorRow[]> {
    const connections = await this.request('/api/connections')

    if (!Array.isArray(connections)) {
      throw new Error('连接器返回了无效状态。')
    }

    return (Object.keys(CONNECTOR_SPECS) as ConnectorId[]).map(id => ({
      id,
      connected: connections.some(
        row => row.service === id && row.connectionName === 'default' && row.configured === true
      )
    }))
  }

  /** 正常退出和账号退出都撤销服务进程，不删除持久授权。 */
  async close(): Promise<void> {
    this.closed = true
    const child = this.child
    this.child = null

    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connector process did not exit')), 5000)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
      child.kill()
    })
  }
}
