import fs from 'node:fs'
import path from 'node:path'

import { type Document, isMap, isScalar, isSeq, type Node, parseDocument, type YAMLMap } from 'yaml'

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

/**
 * 有元景套餐时隐藏 Hermes 自带的看图工具组：它用主模型看图，主模型不支持时每次报错，
 * 模型还会先试它再绕回工具箱的 analyze_image。已在列表里或配置是共享引用时不动。
 */
function hideBuiltinVision(doc: Document): void {
  const agent = doc.get('agent')

  if (doc.has('agent') && !isIndependentMap(agent)) {
    return
  }

  const current = isMap(agent) ? agent.get('disabled_toolsets', true) : undefined

  if (isSeq(current)) {
    if (!current.anchor && !current.items.some(item => isScalar(item) && item.value === 'vision')) {
      current.add(doc.createNode('vision'))
    }

    return
  }

  // Hermes 也接受只写一个名字的写法，保留原来的名字再加上 vision。
  const single = isScalar(current) ? current.value : current

  if (single === 'vision' || (single != null && single !== '' && typeof single !== 'string')) {
    return
  }

  if (!doc.has('agent')) {
    doc.set('agent', doc.createNode({}))
  }

  doc.setIn(['agent', 'disabled_toolsets'], doc.createNode(single ? [single, 'vision'] : ['vision']))
}

/** 只为翻译与播客留足 MCP 的 600 秒等待期；保留用户已配置的单工具上限。 */
function configureBackgroundTimeouts(doc: Document): void {
  const keys = ['timeouts', 'tools', 'sequential_calls']

  for (let depth = 1; depth <= keys.length; depth++) {
    const currentPath = keys.slice(0, depth)

    if (doc.hasIn(currentPath) && !isIndependentMap(doc.getIn(currentPath))) {
      return
    }
  }

  for (let depth = 1; depth <= keys.length; depth++) {
    const currentPath = keys.slice(0, depth)

    if (!doc.hasIn(currentPath)) {
      doc.setIn(currentPath, doc.createNode({}))
    }
  }

  for (const name of ['doc_translate', 'ai_podcast_generate']) {
    const key = [...keys, `mcp__UniAI_Toolkit__${name}`]

    if (!doc.hasIn(key)) {
      doc.setIn(key, 630)
    }
  }
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

    hideBuiltinVision(doc)
    configureBackgroundTimeouts(doc)

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
