import { browserShellCopy } from '@/lib/browser-shell'

/**
 * Keys on the MCP page (app/skills/mcp-tab.tsx), masked by the browser bridge.
 *
 * The page shows each server's configuration as hermes hands it out, with the
 * `${VAR}` references expanded. The platform's own server carries the user's
 * key in its address (`…/mcp?key=${…}`), so the key showed in full. The bridge
 * masks keys in what the page reads and puts the real values back in what it
 * saves: the page only shows `sk-••••••abcd`, and a save still sends the value
 * hermes handed out, which hermes stores as the reference it came from
 * (`_preserve_env_ref_templates`, hermes_cli/config.py).
 *
 * Masked: a URL's password and its secret query parameters (the names hermes
 * redacts in its logs, agent/redact.py); header and environment values whose
 * names say they hold a credential; the same in `args` (`--api-key=…`,
 * `--token …`). For display only: the instance still has the key.
 */

const DOTS = '••••••'

// agent/redact.py `_SENSITIVE_QUERY_PARAMS`
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

// Authorization, X-API-Key, GITHUB_TOKEN, OPENAI_API_KEY, --api-key, …
const SECRET_NAME_RE =
  /(?:^|[-_.])(?:api[-_]?key|auth|authorization|cookie|credentials?|jwt|key|pass|passwd|password|pwd|secret|token)(?:$|[-_.])/i

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i
const FLAG_RE = /^--?[A-Za-z][\w.-]*$/
const INLINE_FLAG_RE = /^(--?([A-Za-z][\w.-]*)=)(.+)$/

// mask → the value it stands for, and the other way round
const originals = new Map<string, string>()
const masks = new Map<string, string>()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Unset references come through as `${VAR}`; they give nothing away.
const worthMasking = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && !value.includes('${') && !value.includes(DOTS)

function maskOf(value: string): string {
  const known = masks.get(value)

  if (known !== undefined) {
    return known
  }

  // As hermes' own redaction: short values are all dots; long ones keep the
  // vendor prefix (`sk-`) and the last 4 characters.
  const long = value.length >= 18
  const head = long ? (/^[A-Za-z]{1,5}[-_]/.exec(value)?.[0] ?? '') : ''
  const tail = long ? value.slice(-4) : ''
  let dots = DOTS

  // Another value already shows like this: one more dot tells them apart.
  while (originals.has(head + dots + tail)) {
    dots += '•'
  }

  const mask = head + dots + tail

  originals.set(mask, value)
  masks.set(value, mask)

  return mask
}

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/g, ' '))
  } catch {
    return name
  }
}

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

// `scheme://user:password@host/…?key=…#…`: the password and the secret parameters.
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

// `Bearer sk-…` keeps its scheme.
function maskCredential(value: string): string {
  const scheme = /^([A-Za-z][\w.+-]*\s+)(\S+)$/.exec(value)

  return scheme ? scheme[1] + maskOf(scheme[2]) : maskOf(value)
}

// Headers and environment values: masked when the name says they hold a
// credential; a URL (DATABASE_URL=postgres://user:password@…) like any other.
function maskNamed(values: Record<string, unknown>, mask: (value: string) => string): Record<string, unknown> {
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

function restoreText(text: string): string {
  if (!text.includes(DOTS)) {
    return text
  }

  let restored = text

  // Longest first: `••••••abcd` is part of `•••••••abcd`.
  for (const [mask, original] of [...originals].sort(([a], [b]) => b.length - a.length)) {
    restored = restored.split(mask).join(original)
  }

  // A mask this page never handed out (copied from another tab, typed): saving
  // it would replace the key with dots.
  if (restored.includes(DOTS)) {
    throw new Error(browserShellCopy().mcpKeyStale)
  }

  return restored
}

function restore(value: unknown): unknown {
  if (typeof value === 'string') {
    return restoreText(value)
  }

  if (Array.isArray(value)) {
    return value.map(restore)
  }

  return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item)])) : value
}

const route = (path: string) => path.split('?')[0]

/** What the page reads: `GET /api/config` (`mcp_servers`), `GET /api/mcp/servers`
 * and the server `POST /api/mcp/servers` answers with. */
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

/** What the page saves: `PUT /api/mcp/servers` (the whole map), `PUT /api/config`
 * (the whole record, `mcp_servers` included) and `POST /api/mcp/servers`. Throws
 * when a mask cannot be put back. */
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
