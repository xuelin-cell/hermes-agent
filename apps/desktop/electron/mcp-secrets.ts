// 移植 Web 版 3cffcc2937 的打码规则；映射只留在当前窗口的隔离 preload 中。
// 保存时还原读取值，由 Hermes 原生配置保存保留原有 ${VAR} 引用。
const DOTS = '••••••'

const SECRET_QUERY_PARAMS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'client_secret',
  'code',
  'id_token',
  'jwt',
  'key',
  'password',
  'refresh_token',
  'secret',
  'session',
  'signature',
  'token',
  'x-amz-signature'
])

const SECRET_NAME_RE =
  /(?:^|[-_.])(?:api[-_]?key|auth|authorization|cookie|credentials?|jwt|key|pass|passwd|password|pwd|secret|token)(?:$|[-_.])/i

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i
const FLAG_RE = /^--?[A-Za-z][\w.-]*$/
const INLINE_FLAG_RE = /^(--?([A-Za-z][\w.-]*)=)(.+)$/
const originals = new Map<string, string>()
const masks = new Map<string, string>()

/** 只处理普通对象，数组由各字段单独处理。 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 未展开的环境变量、空值和已经打码的值不再处理。 */
const worthMasking = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && !value.includes('${') && !value.includes(DOTS)

/** 为密钥分配稳定打码值，避免相同后缀的不同密钥还原混淆。 */
function maskOf(value: string): string {
  const known = masks.get(value)

  if (known !== undefined) {
    return known
  }

  const long = value.length >= 18
  const head = long ? (/^[A-Za-z]{1,5}[-_]/.exec(value)?.[0] ?? '') : ''
  const tail = long ? value.slice(-4) : ''
  let dots = DOTS

  while (originals.has(head + dots + tail)) {
    dots += '•'
  }

  const mask = head + dots + tail
  originals.set(mask, value)
  masks.set(value, mask)

  return mask
}

/** 解码查询参数名，无法解码时保留原名。 */
function decodeName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/g, ' '))
  } catch {
    return name
  }
}

/** 只打码凭据参数的值，不改地址编码与普通参数。 */
function maskParam(pair: string): string {
  const eq = pair.indexOf('=')

  if (eq <= 0) {
    return pair
  }

  const name = decodeName(pair.slice(0, eq))
  const value = pair.slice(eq + 1)

  return (SECRET_QUERY_PARAMS.has(name.toLowerCase()) || SECRET_NAME_RE.test(name)) && worthMasking(value)
    ? `${pair.slice(0, eq)}=${maskOf(value)}`
    : pair
}

/** 打码 URL 中的密码与凭据参数，保留其余部分。 */
function maskUrl(url: string): string {
  const hashAt = url.indexOf('#')
  const end = hashAt < 0 ? url.length : hashAt
  const queryAt = url.slice(0, end).indexOf('?')

  const base = url
    .slice(0, queryAt < 0 ? end : queryAt)
    .replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#@:]*:)([^/?#@]+)@/i, (whole, user: string, password: string) =>
      worthMasking(password) ? `${user}${maskOf(password)}@` : whole
    )

  if (queryAt < 0) {
    return base + url.slice(end)
  }

  const query = url
    .slice(queryAt + 1, end)
    .split('&')
    .map(maskParam)
    .join('&')

  return `${base}?${query}${url.slice(end)}`
}

/** 保留 Bearer 等认证方案，只打码实际凭据。 */
function maskCredential(value: string): string {
  const scheme = /^([A-Za-z][\w.+-]*\s+)(\S+)$/.exec(value)

  return scheme ? scheme[1] + maskOf(scheme[2]) : maskOf(value)
}

/** 按名称打码 Header 或环境变量中的凭据，兼顾 URL 密码。 */
function maskNamed(values: Record<string, unknown>, mask: (value: string) => string): Record<string, unknown> {
  /** 普通值原样保留，凭据与 URL 分别处理。 */
  const maskValue = (name: string, value: unknown) => {
    if (!worthMasking(value)) {
      return value
    }

    if (SECRET_NAME_RE.test(name)) {
      return mask(value)
    }

    return URL_RE.test(value) ? maskUrl(value) : value
  }

  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, maskValue(name, value)]))
}

/** 打码命令参数中的凭据值，保留参数名与普通参数。 */
function maskArgs(args: unknown[]): unknown[] {
  return args.map((arg, index) => {
    if (!worthMasking(arg)) {
      return arg
    }

    const inline = INLINE_FLAG_RE.exec(arg)

    if (inline) {
      const [, flag, name, value] = inline

      return SECRET_NAME_RE.test(name) ? flag + maskOf(value) : URL_RE.test(value) ? flag + maskUrl(value) : arg
    }

    const previous = args[index - 1]

    if (typeof previous === 'string' && FLAG_RE.test(previous) && SECRET_NAME_RE.test(previous.replace(/^-+/, ''))) {
      return arg.startsWith('-') ? arg : maskOf(arg)
    }

    return URL_RE.test(arg) ? maskUrl(arg) : arg
  })
}

/** 复制并打码服务配置，不修改后端返回的原对象。 */
function maskServer(server: unknown): unknown {
  if (!isRecord(server)) {
    return server
  }

  const next = { ...server }

  if (worthMasking(next.url)) {
    next.url = maskUrl(next.url)
  }

  if (isRecord(next.headers)) {
    next.headers = maskNamed(next.headers, maskCredential)
  }

  if (isRecord(next.env)) {
    next.env = maskNamed(next.env, maskOf)
  }

  if (Array.isArray(next.args)) {
    next.args = maskArgs(next.args)
  }

  return next
}

/** 还原当前窗口发出的打码值，未知打码值拒绝保存。 */
function restoreText(text: string): string {
  if (!text.includes(DOTS)) {
    return text
  }

  let restored = text

  // 先替换较长打码值，避免短值截断具有相同后缀的长值。
  for (const [mask, original] of [...originals].sort(([a], [b]) => b.length - a.length)) {
    restored = restored.split(mask).join(original)
  }

  if (restored.includes(DOTS)) {
    throw new Error('MCP 密钥打码值已过期，请重新读取配置后再保存。')
  }

  return restored
}

/** 递归还原 MCP 配置中的打码字符串。 */
function restore(value: unknown): unknown {
  if (typeof value === 'string') {
    return restoreText(value)
  }

  if (Array.isArray(value)) {
    return value.map(restore)
  }

  return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item)])) : value
}

/** 去掉查询参数，仅按原生接口路径判断是否处理。 */
const route = (path: string) => path.split('?')[0]

/** 打码配置读取、服务列表与新增服务响应，其他接口不处理。 */
export function maskMcpSecrets<T>(method: string, path: string, data: T): T {
  const call = `${method.toUpperCase()} ${route(path)}`

  if (!isRecord(data)) {
    return data
  }

  if (call === 'GET /api/config' && isRecord(data.mcp_servers)) {
    return {
      ...data,
      mcp_servers: Object.fromEntries(
        Object.entries(data.mcp_servers).map(([name, server]) => [name, maskServer(server)])
      )
    }
  }

  if (call === 'GET /api/mcp/servers' && Array.isArray(data.servers)) {
    return { ...data, servers: data.servers.map(maskServer) }
  }

  return call === 'POST /api/mcp/servers' ? (maskServer(data) as T) : data
}

/** 还原配置保存与新增服务的请求，仅处理 MCP 内容。 */
export function restoreMcpSecrets<T>(method: string, path: string, body: T): T {
  const call = `${method.toUpperCase()} ${route(path)}`

  if (!isRecord(body)) {
    return body
  }

  if (call === 'PUT /api/mcp/servers' && 'servers' in body) {
    return { ...body, servers: restore(body.servers) }
  }

  if (call === 'PUT /api/config' && isRecord(body.config) && 'mcp_servers' in body.config) {
    return { ...body, config: { ...body.config, mcp_servers: restore(body.config.mcp_servers) } }
  }

  return call === 'POST /api/mcp/servers' ? (restore(body) as T) : body
}
