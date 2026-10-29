import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'

import { writeSecretFileAtomic } from '../hardening'
import { LegacySecretFormatError } from '../local-secret-storage'

import {
  CONNECTOR_SPECS,
  type ConnectorId,
  type ConnectorService,
  HIDDEN_CONNECTOR_SERVICES,
  type LocalConnectorRow
} from './contract'
import { preserveLegacyConnector } from './legacy-secrets'

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

/** 凭据验证因超时失败时连接器同样回 400；只读错误码和文字判断是否超时，原文不外传，免得把网络慢说成凭据错。 */
export async function isValidationTimeout(response: Response): Promise<boolean> {
  const body = (await response.json().catch(() => null)) as null | { error?: { code?: unknown; message?: unknown } }
  const error = body?.error

  return (
    error?.code === 'credential_verification_failed' &&
    typeof error.message === 'string' &&
    /credential validation exceeded \d+ms|timed? ?out/i.test(error.message)
  )
}

/** 独立 Node 服务持有第三方凭据；每个 Profile 单独启动、加密和退出。 */
export class ConnectorRuntime {
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private stopping: Promise<void> | null = null
  private origin = ''
  private secrets: RuntimeSecrets | null = null
  private closed = false

  constructor(private readonly options: ConnectorRuntimeOptions) {}

  /** 只发布绑定本 Profile 的运行时令牌，管理令牌始终留在主进程。 */
  async config(id: ConnectorService): Promise<Record<string, unknown>> {
    await this.start()

    return {
      url: `${this.origin}/mcp`,
      headers: { Authorization: `Bearer ${this.secrets!.runtime}`, 'X-OpenConnector-Allowed-Services': id },
      ...(Object.hasOwn(CONNECTOR_SPECS, id) ? { desktop_connector: id } : {}),
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
    preserveLegacyConnector(this.options.directory)

    for (const name of ['secrets.enc', 'connect.sqlite', 'connect.sqlite-wal', 'connect.sqlite-shm']) {
      const stat = fs.lstatSync(path.join(this.options.directory, name), { throwIfNoEntry: false })

      if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
        throw new Error('Invalid connector storage file')
      }
    }

    const file = path.join(this.options.directory, 'secrets.enc')

    if (fs.existsSync(file)) {
      let plaintext: string

      try { plaintext = this.options.decrypt(fs.readFileSync(file)) } catch (error) {
        if (!(error instanceof LegacySecretFormatError)) {throw error}
        preserveLegacyConnector(this.options.directory, true)

        return this.readSecrets()
      }

      const value = JSON.parse(plaintext) as RuntimeSecrets

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
      OOMOL_CONNECT_MCP_ALLOWED_SERVICES: [...Object.keys(CONNECTOR_SPECS), ...HIDDEN_CONNECTOR_SERVICES].join(',')
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
      if (response.status === 400 && (await isValidationTimeout(response))) {
        throw new Error('连接服务器超时，请检查网络后重试。')
      }

      throw new Error(
        response.status === 400 ? '连接器拒绝了连接，请核对凭据或授权设置。' : '连接器服务请求失败，请稍后重试。'
      )
    }

    return response.json()
  }

  /** Download only a transit URL minted by this runtime; the renderer never supplies a URL. */
  async download(url: string): Promise<Response> {
    await this.start()
    const target = new URL(url)

    if (target.origin !== this.origin) {
      throw new Error('Invalid connector download URL')
    }

    const response = await fetch(target, {
      headers: { Authorization: `Bearer ${this.secrets!.runtime}` },
      signal: AbortSignal.timeout(60_000)
    })

    if (!response.ok || !response.body) {
      throw new Error('Connector attachment download failed')
    }

    return response
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

  async connection(service: ConnectorService): Promise<null | { configured: boolean; displayName: string }> {
    const connections = await this.request('/api/connections')

    if (!Array.isArray(connections)) {
      throw new Error('连接器返回了无效状态。')
    }

    const row = connections.find(
      item => item?.service === service && item?.connectionName === 'default' && item?.configured === true
    )

    if (!row) {
      return null
    }

    return {
      configured: true,
      displayName: typeof row.profile?.displayName === 'string' ? row.profile.displayName : ''
    }
  }

  /** 正常退出和账号退出都撤销服务进程，不删除持久授权。 */
  close(): Promise<void> {
    this.closed = true

    if (this.stopping) {
      return this.stopping
    }

    const child = this.child

    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve()
    }

    this.stopping = this.stopChild(child).finally(() => {
      this.stopping = null
    })

    return this.stopping
  }

  /** 正常停止超时后只强停自己持有的句柄；失败保留引用，重试仍须确认真实退出。 */
  private stopChild(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      /** 收尾时清除本次监听与计时器，避免重试累积或误报超时。 */
      const finish = (error?: Error): void => {
        clearTimeout(timeout)
        child.removeListener('exit', onExit)
        child.removeListener('error', onError)

        if (error) { reject(error) } else { resolve() }
      }

      /** 以退出事件确认停止，发送信号成功不代表进程已经结束。 */
      const onExit = (): void => finish()
      /** 无法发送信号时拒绝退出，不丢弃尚未确认停止的连接器。 */
      const onError = (): void => finish(new Error('连接器进程尚未停止，请重试退出。'))

      let timeout = setTimeout(() => {
        timeout = setTimeout(onError, 5000)

        try { child.kill('SIGKILL') } catch { onError() }
      }, 5000)

      child.once('exit', onExit)
      child.once('error', onError)

      try { child.kill('SIGTERM') } catch { onError() }
    })
  }
}
