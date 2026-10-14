import fs from 'node:fs'
import path from 'node:path'

import { isMap, isScalar, type Node, parseDocument, type YAMLMap } from 'yaml'

import { writeSecretFileAtomic } from '../hardening'
import type { FetchedPlan } from '../login/plan'

import { MAAS_MODEL_KEY_ENV } from './model-config'

const SERVER = 'UniAI-Toolkit'
const SERVER_URL = `https://maas.ai-yuanjing.com/app/mcp-server/mcp?key=\${${MAAS_MODEL_KEY_ENV}}&client_id=UniWork`
const OPTIONS = { version: '1.1' as const, intAsBigInt: true, prettyErrors: false, logLevel: 'silent' as const }

/** 共享映射和合并键不改写，避免影响用户引用的其他配置。 */
function isIndependentMap(value: unknown): value is YAMLMap {
  return (
    isMap(value) && !value.anchor && !value.items.some(pair => isScalar(pair.key) && typeof pair.key.value === 'symbol')
  )
}

/** 后端启动前按套餐维护默认 Home 的内置记录，只更新地址与超时，不接触其他服务。 */
export function updateUniaiToolkitConfig(home: string, status: FetchedPlan['status']): void {
  if (status === 'failed') {
    return
  }

  const file = path.join(home, 'config.yaml')
  const existing = fs.lstatSync(file, { throwIfNoEntry: false })

  if (!existing && status === 'empty') {
    return
  }

  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error('账号 MCP 配置必须是可读的普通文件。')
  }

  const original = existing ? fs.readFileSync(file, 'utf8') : ''
  const doc = parseDocument<Node>(original, OPTIONS)

  if (doc.errors.length || doc.warnings.length || (doc.contents && !isMap(doc.contents))) {
    throw new Error('账号 MCP 配置无效，请修复 config.yaml 后重试。')
  }

  try {
    doc.toJS()
  } catch {
    throw new Error('账号 MCP 配置含无效引用，请修复后重试。')
  }

  if (!doc.contents) {
    doc.contents = doc.createNode({})
  }

  const servers = doc.get('mcp_servers')
  const entry = isMap(servers) ? servers.get(SERVER) : undefined

  if (
    !isIndependentMap(doc.contents) ||
    (doc.has('mcp_servers') && !isIndependentMap(servers)) ||
    (isMap(servers) && servers.has(SERVER) && !isIndependentMap(entry))
  ) {
    return
  }

  if (status === 'empty') {
    if (!isMap(servers) || !servers.has(SERVER)) {
      return
    }

    servers.delete(SERVER)
  } else {
    const timeout = isMap(entry) ? entry.get('timeout') : undefined

    if (isMap(entry) && entry.get('url') === SERVER_URL && (timeout === 600 || timeout === 600n)) {
      return
    }

    if (!doc.has('mcp_servers')) {
      doc.set('mcp_servers', doc.createNode({}))
    }

    if (!isMap(entry)) {
      doc.setIn(['mcp_servers', SERVER], doc.createNode({}))
    }

    if (!isMap(entry) || entry.get('url') !== SERVER_URL) {
      doc.setIn(['mcp_servers', SERVER, 'url'], SERVER_URL)
    }

    if (timeout !== 600 && timeout !== 600n) {
      doc.setIn(['mcp_servers', SERVER, 'timeout'], 600)
    }
  }

  const next = doc.toString({ lineWidth: 0 })

  try {
    parseDocument(next, OPTIONS).toJS()
  } catch {
    throw new Error('更新 MCP 会影响已有 YAML 引用，原配置保持不变。')
  }

  if (next !== original) {
    writeSecretFileAtomic(file, next, { encoding: 'utf8' })
  }
}
