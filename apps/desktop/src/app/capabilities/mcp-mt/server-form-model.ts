import { tokenize } from '@/lib/mcp-import'
import { type McpServerEntry, type McpServers, serverEnabled } from '@/lib/mcp-servers'

// The connectors page edits `mcp_servers` through a UniWork-style form instead
// of raw JSON. Everything here is pure: form ⇄ entry conversion, validation and
// the "does this save touch a running server" rule. Fields the form does not
// show (timeout, tools filter, trust, auth, …) always ride along untouched.

/** Electron writes this entry for MaaS plans (`electron/entry_local/uniai-toolkit-config.ts`). */
export const BUILT_IN_SERVER = 'UniAI-Toolkit'
export const ARXIV_BUILT_IN_SERVER = 'arXiv-mcp'

const BUILT_IN_SUMMARIES = {
  [BUILT_IN_SERVER]: 'uniAiToolkitSummary',
  [ARXIV_BUILT_IN_SERVER]: 'arxivSummary'
} as const

export type BuiltInServerSummary = (typeof BUILT_IN_SUMMARIES)[keyof typeof BUILT_IN_SUMMARIES]

export type FormTransport = 'http' | 'stdio'

export interface KeyValueRow {
  key: string
  value: string
}

export interface ServerForm {
  args: string
  command: string
  env: KeyValueRow[]
  headers: KeyValueRow[]
  name: string
  transport: FormTransport
  url: string
}

export type FormError = 'argsQuote' | 'commandRequired' | 'nameRequired' | 'nameTaken' | 'urlRequired'

const HTTP_FIELDS = ['url', 'headers'] as const
const STDIO_FIELDS = ['command', 'args', 'env', 'cwd'] as const

/** 内置服务只读：只能开关，不能编辑或删除。 */
export const isBuiltInServer = (name: string | null): name is keyof typeof BUILT_IN_SUMMARIES =>
  name !== null && Object.hasOwn(BUILT_IN_SUMMARIES, name)

/** Electron 写入的连接器桥接服务由连接器页管理，不属于用户自定义 MCP。 */
export const isDesktopConnectorServer = (entry: McpServerEntry | undefined): boolean =>
  typeof entry?.desktop_connector === 'string' || entry?.desktop_agent_mail === true

export const builtInServerSummary = (name: string | null): BuiltInServerSummary | null =>
  isBuiltInServer(name) ? BUILT_IN_SUMMARIES[name] : null

/** 有 `url` 即按 HTTP 处理，与运行时选择传输方式的依据一致。 */
export const transportOf = (entry: McpServerEntry): FormTransport => (typeof entry.url === 'string' ? 'http' : 'stdio')

/** 一个参数含空白或引号时加双引号，保证能被 `tokenize` 原样拆回。 */
function quoteArg(arg: string): string {
  return arg === '' || /[\s"'\\]/.test(arg) ? `"${arg.replace(/["\\]/g, '\\$&')}"` : arg
}

/** 把参数数组显示成一行文字。 */
export function formatArgs(args: unknown): string {
  return Array.isArray(args) ? args.map(arg => quoteArg(String(arg))).join(' ') : ''
}

/** 键值对象转成可编辑的行；非对象一律视为空。 */
function rowsOf(value: unknown): KeyValueRow[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return []
  }

  return Object.entries(value).map(([key, item]) => ({ key, value: String(item ?? '') }))
}

/** 行转回对象：跳过空键，重复键以后一行为准。 */
function objectOf(rows: readonly KeyValueRow[]): Record<string, string> {
  return Object.fromEntries(rows.filter(row => row.key.trim()).map(row => [row.key.trim(), row.value]))
}

/** 空白表单，用于“添加 MCP 服务器”。 */
export function blankForm(transport: FormTransport): ServerForm {
  return { args: '', command: '', env: [], headers: [], name: '', transport, url: '' }
}

/** 从已保存的配置生成表单。 */
export function formFromEntry(name: string, entry: McpServerEntry): ServerForm {
  return {
    args: formatArgs(entry.args),
    command: typeof entry.command === 'string' ? entry.command : '',
    env: rowsOf(entry.env),
    headers: rowsOf(entry.headers),
    name,
    transport: transportOf(entry),
    url: typeof entry.url === 'string' ? entry.url : ''
  }
}

/** 检查表单能否保存；`taken` 是其他服务已占用的名称。 */
export function validateForm(form: ServerForm, taken: readonly string[]): FormError | null {
  const name = form.name.trim()

  if (!name) {
    return 'nameRequired'
  }

  if (taken.includes(name)) {
    return 'nameTaken'
  }

  if (form.transport === 'http') {
    return form.url.trim() ? null : 'urlRequired'
  }

  if (!form.command.trim()) {
    return 'commandRequired'
  }

  return tokenize(form.args) === null ? 'argsQuote' : null
}

/** 用表单覆盖原配置的传输字段，其余字段原样保留；切换类型时去掉另一种类型的字段。 */
export function entryFromForm(form: ServerForm, base: McpServerEntry): McpServerEntry {
  const next: McpServerEntry = { ...base }
  const dropped = form.transport === 'http' ? STDIO_FIELDS : HTTP_FIELDS

  for (const field of dropped) {
    delete next[field]
  }

  // `transport` names sse/http variants for URL servers only.
  if (
    form.transport === 'stdio' ? next.transport !== undefined && next.transport !== 'stdio' : next.transport === 'stdio'
  ) {
    delete next.transport
  }

  if (form.transport === 'http') {
    next.url = form.url.trim()
    setOrDrop(next, 'headers', objectOf(form.headers))
  } else {
    next.command = form.command.trim()
    const args = tokenize(form.args) ?? []
    setOrDrop(next, 'args', args.length > 0 ? args : undefined)
    setOrDrop(next, 'env', objectOf(form.env))
  }

  return next
}

/** 空对象或空值不写入配置，避免留下 `headers: {}` 这类空字段。 */
function setOrDrop(entry: McpServerEntry, key: string, value: unknown): void {
  const empty = value === undefined || (typeof value === 'object' && value !== null && Object.keys(value).length === 0)

  if (empty) {
    delete entry[key]
  } else {
    entry[key] = value
  }
}

/** 写入一条配置；`from` 与 `to` 不同即改名，并保持原有顺序。新条目追加到末尾。 */
export function placeServer(servers: McpServers, from: null | string, to: string, entry: McpServerEntry): McpServers {
  if (from === null || !(from in servers)) {
    return { ...servers, [to]: entry }
  }

  return Object.fromEntries(
    Object.entries(servers).map(([name, value]) => (name === from ? [to, entry] : [name, value]))
  )
}

/** 只有启用中的服务被增删或改动时，后端才需要重载连接。 */
export function needsReload(prev: McpServers, next: McpServers): boolean {
  const names = new Set([...Object.keys(prev), ...Object.keys(next)])

  for (const name of names) {
    const before = prev[name]
    const after = next[name]
    const live = (before !== undefined && serverEnabled(before)) || (after !== undefined && serverEnabled(after))

    if (live && JSON.stringify(before) !== JSON.stringify(after)) {
      return true
    }
  }

  return false
}

/** 表单内容与已保存配置是否不同（用于“改了就关闭”）。 */
export function formChanged(form: ServerForm, name: string, entry: McpServerEntry): boolean {
  return JSON.stringify(form) !== JSON.stringify(formFromEntry(name, entry))
}
