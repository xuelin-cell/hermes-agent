import fs from 'node:fs'
import path from 'node:path'

import { type Document, isMap, isScalar, isSeq, type Node, parseDocument, type YAMLMap } from 'yaml'

import { writeSecretFileAtomic } from '../hardening'
import type { FetchedPlan } from '../login/plan'

import { MAAS_MODEL_KEY_ENV } from './model-config'

const SERVER = 'UniAI-Toolkit'
const SERVER_URL = `https://maas.ai-yuanjing.com/app/mcp-server/mcp?key=\${${MAAS_MODEL_KEY_ENV}}&client_id=UniWork`
const ARXIV_SERVER = 'arXiv-mcp'
const ARXIV_SERVER_URL = 'https://arxiv.caseyjhand.com/mcp'
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

/** 元景工具箱整体的 MCP 等待上限，取单工具里最长的翻译预算（对齐 UniWork）。 */
const SERVER_TIMEOUT = 1000

/**
 * 耗时工具的外层等待上限：UniWork 的单工具预算（翻译 1000、播客 900、视频 360）再加 30 秒，
 * 让工具箱自己的超时先返回。其他元景工具不单列，沿用 Hermes 的默认上限。
 */
const TOOL_TIMEOUTS: Record<string, number> = {
  doc_translate: 1030,
  ai_podcast_generate: 930,
  txt2vid_generate: 390,
  img2vid_generate: 390
}

/** 早先版本给翻译和播客写入的默认值；仍是这个值说明用户没改过，升级为新预算。 */
const PREVIOUS_TOOL_TIMEOUT = 630
const PREVIOUS_TOOLS = new Set(['doc_translate', 'ai_podcast_generate'])

/** 判断 YAML 读出的数值（开启了 intAsBigInt）是否等于给定整数。 */
function isNumber(value: unknown, expected: number): boolean {
  return value === expected || value === BigInt(expected)
}

/** 为耗时元景工具写入外层等待上限；保留用户已配置的单工具上限，只升级旧版默认值。 */
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

  for (const [name, seconds] of Object.entries(TOOL_TIMEOUTS)) {
    const key = [...keys, `mcp__UniAI_Toolkit__${name}`]
    const upgrade = PREVIOUS_TOOLS.has(name) && isNumber(doc.getIn(key), PREVIOUS_TOOL_TIMEOUT)

    if (!doc.hasIn(key) || upgrade) {
      doc.setIn(key, seconds)
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
  const arxivEntry = isMap(servers) ? servers.get(ARXIV_SERVER) : undefined

  if (
    !isIndependentMap(doc.contents) ||
    (doc.has('mcp_servers') && !isIndependentMap(servers)) ||
    (isMap(servers) &&
      ((servers.has(SERVER) && !isIndependentMap(entry)) ||
        (servers.has(ARXIV_SERVER) && !isIndependentMap(arxivEntry))))
  ) {
    return
  }

  if (status === 'empty') {
    if (isMap(servers) && servers.has(SERVER)) {
      servers.delete(SERVER)
    }
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

    if (!isNumber(timeout, SERVER_TIMEOUT)) {
      doc.setIn(['mcp_servers', SERVER, 'timeout'], SERVER_TIMEOUT)
    }
  }

  // arXiv 是独立于 MaaS 套餐的桌面内置项；保留用户开关和工具过滤，但修正受管地址。
  if (!doc.has('mcp_servers')) {
    doc.set('mcp_servers', doc.createNode({}))
  }

  if (!isMap(arxivEntry)) {
    doc.setIn(['mcp_servers', ARXIV_SERVER], doc.createNode({}))
  }

  if (!isMap(arxivEntry) || arxivEntry.get('url') !== ARXIV_SERVER_URL) {
    doc.setIn(['mcp_servers', ARXIV_SERVER, 'url'], ARXIV_SERVER_URL)
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
