import { execFile } from 'node:child_process'
import path from 'node:path'

import type { LoginIdentity } from '../login/session'

import { accountDesktopEnvironment, accountSourceBackend } from './desktop-environment'
import { desktopPythonPluginsRoot } from './desktop-python-plugins'
import type { PreparedLocalContext } from './runtime-context'

const TOOL_CONFIG_URL = 'https://maas.ai-yuanjing.com/app/gateway/uniclaw/system-config?key=tool_config'

// 与原生 sensitive_query_param_name 的凭证形名称保持一致；普通 key／code 等业务字段仍允许。
const sensitiveQueryNames = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth_token',
  'authorization',
  'awsaccesskeyid',
  'client_secret',
  'credential',
  'credentials',
  'jwt',
  'password',
  'passwd',
  'secret',
  'session_id',
  'signature',
  'token',
  'x_amz_security_token',
  'x_amz_signature',
  'x-amz-security-token',
  'x-amz-signature'
])

const pending = new Map<string, Promise<boolean>>()

/** 合并同一账号的刷新；可选搜索配置失败只记录固定诊断，不中断桌面或通知。 */
export function refreshUniSearch(...args: Parameters<typeof runRefresh>): Promise<boolean> {
  const home = args[0].home
  const previous = pending.get(home)

  if (previous) {
    return previous
  }

  const task = runRefresh(...args)
    .catch(() => {
      console.warn('[unisearch-dev] 搜索配置更新未完成，继续使用现有设置。')

      return false
    })
    .finally(() => {
      if (pending.get(home) === task) {
        pending.delete(home)
      }
    })

  pending.set(home, task)

  return task
}

/** 云端仅提供非秘密配置；请求结束后重新核对账号，失败保留已有搜索配置。 */
async function runRefresh(
  context: PreparedLocalContext,
  identity: () => LoginIdentity | null,
  request: typeof fetch,
  appRoot: string,
  resourcesRoot?: string,
  prepare: typeof prepareUniSearchRuntime = prepareUniSearchRuntime
): Promise<boolean> {
  const owner = identity()

  if (!owner) {
    return false
  }

  let remote: Record<string, unknown> | null = null

  try {
    const response = await request(TOOL_CONFIG_URL, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${owner.token}` },
      signal: AbortSignal.timeout(8_000),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store'
    })

    if (!response.ok) {
      throw new Error('tool config unavailable')
    }

    const body = await response.json()
    const envelope = body?.data ?? body

    if (body?.code !== undefined && ![0, '0'].includes(body.code)) {
      throw new Error('tool config rejected')
    }

    if (typeof envelope?.configValue !== 'string' || envelope.configValue.length > 100_000) {
      throw new Error('invalid config')
    }

    const value = JSON.parse(envelope.configValue)

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('invalid config')
    }

    const fields = { ...value.tools, ...value }
    remote = {}

    for (const key of ['unisearch_backend', 'unisearch_url', 'unisearch_display_name', 'fetch_provider']) {
      if (Object.hasOwn(fields, key)) {
        if (typeof fields[key] !== 'string') {
          throw new Error('invalid field')
        }

        remote[key] = fields[key]
      }
    }

    if (remote.unisearch_backend !== undefined && !['bocha', 'tencent'].includes(String(remote.unisearch_backend))) {
      throw new Error('invalid backend')
    }

    if (remote.fetch_provider !== undefined && !['builtin_parse', 'unicrawl'].includes(String(remote.fetch_provider))) {
      throw new Error('invalid fetch provider')
    }

    if (remote.unisearch_url) {
      const url = new URL(String(remote.unisearch_url))

      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash ||
        [...url.searchParams].some(
          ([name, value]) => value && sensitiveQueryNames.has(decodeURIComponent(name).toLowerCase())
        )
      ) {
        throw new Error('invalid URL')
      }
    }

    if (!Object.keys(remote).length) {
      throw new Error('empty config')
    }

    if (typeof envelope.version === 'string') {
      remote.version = envelope.version
    }
  } catch {
    remote = null
  }

  const current = identity()

  if (current?.uid !== owner.uid || current?.token !== owner.token) {
    return false
  }

  const root = desktopPythonPluginsRoot(appRoot, resourcesRoot)
  await writeUniSearchConfiguration(context, root, remote)
  await prepare(context, root)

  return remote !== null
}

/** 后端发现前只准备本地默认配置；搜索写入失败时保留账号及原有工具可用性。 */
export async function prepareUniSearchConfiguration(
  context: PreparedLocalContext,
  appRoot: string,
  resourcesRoot?: string
): Promise<boolean> {
  try {
    await writeUniSearchConfiguration(context, desktopPythonPluginsRoot(appRoot, resourcesRoot), null)

    return true
  } catch {
    console.warn('[unisearch-dev] 搜索配置准备未完成，继续启动桌面。')

    return false
  }
}

/** 固定脚本使用原生原子写入器；凭证不进入命令行，失败不回显配置或异常原文。 */
async function writeUniSearchConfiguration(
  context: PreparedLocalContext,
  root: string,
  remote: Record<string, unknown> | null
): Promise<void> {
  const accountEnv = accountDesktopEnvironment(context)
  const backend = accountSourceBackend(context, [], accountEnv)

  const child = execFile(backend.command, [path.join(root, 'unisearch', 'configure.py'), context.home], {
    env: { ...accountEnv, ...backend.env },
    cwd: context.installationRoot,
    windowsHide: true,
    timeout: 15_000
  })

  let diagnostic = ''
  child.stderr?.on('data', chunk => {
    diagnostic = (diagnostic + String(chunk)).slice(-4000)
  })

  const completed = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.stdin?.once('error', reject)
    child.once('exit', code => (code === 0 ? resolve() : reject(new Error('搜索配置保存失败', { cause: diagnostic }))))
  })

  child.stdin?.end(JSON.stringify(remote))
  await completed
}

/** 后台依赖准备沿可信账号的 PM 选择运行，失败只影响需要该依赖的抓取能力。 */
export function prepareUniSearchRuntime(context: PreparedLocalContext, root: string): Promise<void> {
  const accountEnv = accountDesktopEnvironment(context)
  const backend = accountSourceBackend(context, [], accountEnv)

  return new Promise<void>(resolve => {
    execFile(
      backend.command,
      [path.join(root, 'unisearch', 'prepare.py'), context.home],
      {
        env: { ...accountEnv, ...backend.env, HERMES_BUNDLED_PLUGINS: root },
        cwd: context.installationRoot,
        windowsHide: true,
        timeout: 180_000
      },
      error => {
        if (error) {
          console.warn('[unisearch-dev] 联网抓取组件准备未完成，动态网页抓取可能暂不可用。')
        }

        resolve()
      }
    )
  })
}
