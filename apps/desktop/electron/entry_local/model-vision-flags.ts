import fs from 'node:fs'
import path from 'node:path'

import { isMap, isScalar, isSeq, type Node, parseDocument, YAMLMap } from 'yaml'

import { writeSecretFileAtomic } from '../hardening'

const OPTIONS = { version: '1.1' as const, intAsBigInt: true, prettyErrors: false, logLevel: 'silent' as const }
const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

/** 共享映射和合并键不改写，避免影响用户引用的其他配置。 */
function isIndependentMap(value: unknown): value is YAMLMap {
  return (
    isMap(value) && !value.anchor && !value.items.some(pair => isScalar(pair.key) && typeof pair.key.value === 'symbol')
  )
}

/**
 * 一个提供方下没写明的模型该补成什么：设置页勾了“图片”的补 true，其余补 false；
 * 输入类型写成看不懂的样子时返回 undefined，整个提供方都不动。
 */
function visionOf(modalities: unknown): boolean | undefined {
  if (modalities === undefined || modalities === null) {
    return false
  }

  if (!isSeq(modalities) || modalities.anchor) {
    return undefined
  }

  const values = modalities.items.map(item => (isScalar(item) ? item.value : undefined))

  return values.every(value => typeof value === 'string') ? values.includes('image') : undefined
}

/** 给一份 config.yaml 里没写明能不能看图的模型补上 supports_vision；无效或看不懂的配置原样不动。 */
function markConfig(file: string): void {
  const existing = fs.lstatSync(file, { throwIfNoEntry: false })

  if (!existing || !existing.isFile() || existing.isSymbolicLink()) {
    return
  }

  const original = fs.readFileSync(file, 'utf8')
  const doc = parseDocument<Node>(original, OPTIONS)

  if (doc.errors.length || doc.warnings.length || !isIndependentMap(doc.contents)) {
    return
  }

  try {
    doc.toJS()
  } catch {
    return
  }

  const providers = doc.get('providers')

  if (!isIndependentMap(providers)) {
    return
  }

  let changed = false

  for (const pair of providers.items) {
    const entry = pair.value
    const vision = isIndependentMap(entry) ? visionOf(entry.get('input_modalities', true)) : undefined
    const models = isIndependentMap(entry) ? entry.get('models', true) : undefined

    if (!isIndependentMap(entry) || vision === undefined || (models != null && !isIndependentMap(models))) {
      continue
    }

    const options = isMap(models) ? models : new YAMLMap(doc.schema)
    const current = entry.get('model')
    const names = options.items.flatMap(item => (isScalar(item.key) && typeof item.key.value === 'string' ? [item.key.value] : []))

    if (typeof current === 'string' && current.trim() && !names.includes(current)) {
      names.push(current)
    }

    for (const name of names) {
      const row = options.get(name, true)

      if (row === undefined || row === null || (isScalar(row) && row.value === null)) {
        options.set(name, doc.createNode({ supports_vision: vision }))
        changed = true
      } else if (isIndependentMap(row) && !row.has('supports_vision')) {
        row.set('supports_vision', vision)
        changed = true
      }
    }

    if (!isMap(models) && options.items.length) {
      entry.set('models', options)
    }
  }

  // 没补任何模型就不重写文件，免得只因 YAML 排版不同改动用户的配置。
  if (!changed) {
    return
  }

  const next = doc.toString({ lineWidth: 0 })

  try {
    parseDocument(next, OPTIONS).toJS()
  } catch {
    return
  }

  writeSecretFileAtomic(file, next, { encoding: 'utf8' })
}

/**
 * 启动准备账号时，给主助手和每个专家助手配置里没写明的模型补上 `supports_vision`。
 * Hermes 只有选“谁来描述历史图片”时把没写明当成能看图：会话中途换到文字模型后，每次请求前都拿它去
 * 描述历史图片（10-29 DeepSeek 每张约 11 秒、内容可能是编的）；其余判断都要明确写 true 才算能看，
 * 所以没写明的补 false 不改变其他行为，设置页勾了“图片”的补 true 以用户勾选为准。
 * 已写明的、共享引用和看不懂的配置原样不动；单个文件出错只跳过它，不挡登录。
 */
export function markModelVisionFlags(accountHome: string): void {
  const homes = [accountHome]
  const profilesDir = path.join(accountHome, 'profiles')
  const stat = fs.lstatSync(profilesDir, { throwIfNoEntry: false })

  if (stat?.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && PROFILE_NAME.test(entry.name)) {
        homes.push(path.join(profilesDir, entry.name))
      }
    }
  }

  for (const home of homes) {
    try {
      markConfig(path.join(home, 'config.yaml'))
    } catch {
      // 某个助手的配置读写失败时保持原样，其余助手照常补。
    }
  }
}
