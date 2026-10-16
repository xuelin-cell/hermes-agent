import fs from 'node:fs'
import path from 'node:path'

import { isMap, isScalar, isSeq, type Node, parseDocument, type YAMLMap } from 'yaml'

import { writeSecretFileAtomic } from '../hardening'

const PLUGIN = 'uniwork-kits'
const OPTIONS = { version: '1.1' as const, intAsBigInt: true, prettyErrors: false, logLevel: 'silent' as const }

/** 共享映射和合并键不改写，避免影响用户引用的其他配置。 */
function isIndependentMap(value: unknown): value is YAMLMap {
  return (
    isMap(value) && !value.anchor && !value.items.some(pair => isScalar(pair.key) && typeof pair.key.value === 'symbol')
  )
}

function lists(value: unknown, name: string): boolean {
  return isSeq(value) && value.items.some(item => (isScalar(item) ? item.value : item) === name)
}

/**
 * 内置套件和专家靠 uniwork-kits 插件装进账号：后端启动时它把安装包里带的套件和专家
 * 按内容比对后装好。登录时确保它在启用名单里；用户自己写进 disabled 的保持不动。
 */
export function enableUniworkKits(home: string): void {
  const file = path.join(home, 'config.yaml')
  const existing = fs.lstatSync(file, { throwIfNoEntry: false })

  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error('账号插件配置必须是可读的普通文件。')
  }

  const original = existing ? fs.readFileSync(file, 'utf8') : ''
  const doc = parseDocument<Node>(original, OPTIONS)

  if (doc.errors.length || doc.warnings.length || (doc.contents && !isMap(doc.contents))) {
    throw new Error('账号插件配置无效，请修复 config.yaml 后重试。')
  }

  try {
    doc.toJS()
  } catch {
    throw new Error('账号插件配置含无效引用，请修复后重试。')
  }

  if (!doc.contents) {
    doc.contents = doc.createNode({})
  }

  const plugins = doc.get('plugins')

  if (!isIndependentMap(doc.contents) || (doc.has('plugins') && !isIndependentMap(plugins))) {
    return
  }

  const enabled = isMap(plugins) ? plugins.get('enabled') : undefined
  const disabled = isMap(plugins) ? plugins.get('disabled') : undefined

  if (
    lists(enabled, PLUGIN) ||
    lists(disabled, PLUGIN) ||
    (enabled !== undefined && enabled !== null && !isSeq(enabled))
  ) {
    return
  }

  if (!doc.has('plugins')) {
    doc.set('plugins', doc.createNode({}))
  }

  if (isSeq(enabled)) {
    enabled.add(doc.createNode(PLUGIN))
  } else {
    doc.setIn(['plugins', 'enabled'], doc.createNode([PLUGIN]))
  }

  const next = doc.toString({ lineWidth: 0 })

  try {
    parseDocument(next, OPTIONS).toJS()
  } catch {
    throw new Error('启用插件会影响已有 YAML 引用，原配置保持不变。')
  }

  if (next !== original) {
    writeSecretFileAtomic(file, next, { encoding: 'utf8' })
  }
}
