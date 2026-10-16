import fs from 'node:fs'
import path from 'node:path'

import { isMap, isScalar, type Node, parseDocument, type YAMLMap } from 'yaml'

import { writeSecretFileAtomic } from '../hardening'
import { DRIVE_MCP_MANAGED, DRIVE_MCP_SERVER } from '../login/drive-mcp-contract'

/** 只确认当前桌面自己维护的实例，不把用户同名 MCP 服务误认为云盘下载链路。 */
export function isCurrentDriveMcpConfig(accountHome: string, profile: string, url: string, token: string): boolean {
  try {
    if (profile !== 'default' && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) {
      return false
    }

    const home = profile === 'default' ? accountHome : path.join(accountHome, 'profiles', profile)

    for (const folder of profile === 'default'
      ? [accountHome]
      : [accountHome, path.join(accountHome, 'profiles'), home]) {
      const stat = fs.lstatSync(folder)

      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return false
      }
    }

    const file = path.join(home, 'config.yaml')
    const stat = fs.lstatSync(file)

    if (!stat.isFile() || stat.isSymbolicLink()) {
      return false
    }

    const doc = parseDocument(fs.readFileSync(file, 'utf8'), {
      version: '1.1',
      prettyErrors: false,
      logLevel: 'silent'
    })

    if (doc.errors.length || doc.warnings.length) {
      return false
    }

    const entry = doc.toJS()?.mcp_servers?.[DRIVE_MCP_SERVER]

    return (
      entry?.uniwork_managed === DRIVE_MCP_MANAGED &&
      entry.url === url &&
      entry.headers?.Authorization === `Bearer ${token}` &&
      !['false', '0', 'no', 'off'].includes(String(entry.enabled).trim().toLowerCase())
    )
  } catch {
    return false
  }
}

/** 共享 YAML 节点不能局部改写，避免连带修改用户的其他设置。 */
function independent(value: unknown): value is YAMLMap {
  return (
    isMap(value) && !value.anchor && !value.items.some(pair => isScalar(pair.key) && typeof pair.key.value === 'symbol')
  )
}

/** 仅在该 Profile 后端启动前维护本产品自己的 MCP 记录，保留开关、工具过滤及其他服务。 */
export function prepareDriveMcpConfig(accountHome: string, profile: string, url: string, token: string): boolean {
  if (profile !== 'default' && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) {
    return false
  }

  const home = profile === 'default' ? accountHome : path.join(accountHome, 'profiles', profile)

  for (const folder of profile === 'default'
    ? [accountHome]
    : [accountHome, path.join(accountHome, 'profiles'), home]) {
    const stat = fs.lstatSync(folder, { throwIfNoEntry: false })

    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      return false
    }
  }

  const file = path.join(home, 'config.yaml')
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })

  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    return false
  }

  const original = stat ? fs.readFileSync(file, 'utf8') : ''
  const doc = parseDocument<Node>(original, { version: '1.1', prettyErrors: false, logLevel: 'silent' })

  if (doc.errors.length || doc.warnings.length || (doc.contents && !independent(doc.contents))) {
    return false
  }

  try {
    doc.toJS()
  } catch {
    return false
  }

  if (!doc.contents) {
    doc.contents = doc.createNode({})
  }

  const servers = doc.get('mcp_servers')

  if (doc.has('mcp_servers') && !independent(servers)) {
    return false
  }

  const entry = isMap(servers) ? servers.get(DRIVE_MCP_SERVER) : undefined

  if (
    isMap(servers) &&
    servers.has(DRIVE_MCP_SERVER) &&
    (!independent(entry) || entry.get('uniwork_managed') !== DRIVE_MCP_MANAGED)
  ) {
    return false
  }

  if (!doc.has('mcp_servers')) {
    doc.set('mcp_servers', doc.createNode({}))
  }

  if (!entry) {
    doc.setIn(['mcp_servers', DRIVE_MCP_SERVER], doc.createNode({ uniwork_managed: DRIVE_MCP_MANAGED, timeout: 600 }))
  }

  const current = doc.getIn(['mcp_servers', DRIVE_MCP_SERVER]) as YAMLMap
  const headers = current.get('headers')

  if (current.has('headers') && !independent(headers)) {
    return false
  }

  current.set('url', url)

  if (!current.has('headers')) {
    current.set('headers', doc.createNode({}))
  }

  current.setIn(['headers', 'Authorization'], `Bearer ${token}`)
  const next = doc.toString({ lineWidth: 0 })

  try {
    parseDocument(next, { version: '1.1' }).toJS()
  } catch {
    return false
  }

  if (next !== original) {
    writeSecretFileAtomic(file, next, { encoding: 'utf8' })
  }

  return current.get('enabled') !== false
}
