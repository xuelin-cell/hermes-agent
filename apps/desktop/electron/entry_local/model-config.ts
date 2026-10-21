import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { isAlias, isMap, isScalar, type Node, parseDocument, YAMLMap } from 'yaml'

import { writeSecretFileAtomic } from '../hardening'
import type { MaasModel, MaasPlan } from '../login/plan'

export const MAAS_MODEL_KEY_ENV = 'DESKTOP_MT_MAAS_API_KEY'
const PROVIDER_PREFIX = 'desktop-mt-maas-'

/** 固定端点身份；模型重排或同端点增减模型不改变提供方标识。 */
function providerId(baseUrl: string): string {
  return `${PROVIDER_PREFIX}${createHash('sha256').update(baseUrl, 'utf8').digest('hex')}`
}

/** YAML 1.1 将合并键解析成符号，不能用普通字符串键判断共享配置。 */
function hasMerge(map: YAMLMap): boolean {
  return map.items.some(pair => isScalar(pair.key) && typeof pair.key.value === 'symbol')
}

/** 只认领本产品的完整标识、专用凭据引用与匹配端点，不覆盖个人配置。 */
function isManaged(id: string, entry: unknown): entry is YAMLMap {
  if (!isMap(entry) || entry.anchor || hasMerge(entry)) {
    return false
  }

  const api = entry.get('api')
  const baseUrl = entry.get('base_url')

  if (
    ['name', 'api', 'base_url', 'api_mode', 'key_env', 'transport', 'discover_models'].some(field => {
      const value = entry.get(field, true)

      return isAlias(value) || (isScalar(value) && !!value.anchor)
    })
  ) {
    return false
  }

  return (
    typeof api === 'string' &&
    id === providerId(api) &&
    entry.get('key_env') === MAAS_MODEL_KEY_ENV &&
    (!entry.has('base_url') ||
      (typeof baseUrl === 'string' && baseUrl.replace(/\/+$/, '') === api.replace(/\/+$/, ''))) &&
    (!entry.has('api_mode') || entry.get('api_mode') === 'chat_completions') &&
    !['api_key', 'key_cmd', 'api_key_env', 'keyEnv', 'apiKey', 'apiKeyEnv', 'url', 'baseUrl', 'apiMode'].some(field =>
      entry.has(field)
    )
  )
}

/** 只维护套餐提供方；全新文件设置默认，既有文件保留用户选择和其他节点。 */
export function mergeMaasModelConfig(home: string, catalog: Pick<MaasPlan, 'models' | 'mainModelIndex'>): void {
  const file = path.join(home, 'config.yaml')
  let existing: fs.Stats | undefined
  let original: string

  try {
    existing = fs.lstatSync(file, { throwIfNoEntry: false })

    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new Error()
    }

    original = existing ? fs.readFileSync(file, 'utf8') : ''
  } catch (error) {
    throw new Error('无法读取账号模型配置，请确认 config.yaml 是可读的普通文件。', { cause: error })
  }

  const options = { version: '1.1' as const, intAsBigInt: true, prettyErrors: false, logLevel: 'silent' as const }
  const doc = parseDocument<Node>(original, options)

  if (doc.errors.length || doc.warnings.length || (doc.contents && !isMap(doc.contents))) {
    throw new Error('账号模型配置无效，请修复 config.yaml 后重试。')
  }

  try {
    doc.toJS()
  } catch {
    throw new Error('账号模型配置含无效引用，请修复后重试。')
  }

  if (!doc.contents) {
    doc.contents = doc.createNode({})
  }

  if (isMap(doc.contents) && (doc.contents.anchor || hasMerge(doc.contents))) {
    throw new Error('账号模型配置不能使用顶层共享引用或 YAML 合并，请展开配置后重试。')
  }

  const providers = doc.get('providers')

  if (doc.has('providers') && (!isMap(providers) || providers.anchor || hasMerge(providers))) {
    throw new Error('提供方配置必须是独立的 YAML 映射，请修复后重试。')
  }

  if (!doc.has('providers')) {
    doc.set('providers', new YAMLMap(doc.schema))
  }

  const groups = new Map<string, MaasModel[]>()

  for (const model of catalog.models) {
    const group = groups.get(model.baseUrl) ?? []
    group.push(model)
    groups.set(model.baseUrl, group)
  }

  const main = catalog.models[catalog.mainModelIndex]

  if (!main) {
    throw new Error('缺少有效的 MaaS 主模型。')
  }

  const activeIds = new Set([...groups.keys()].map(providerId))

  for (const [api, models] of groups) {
    const id = providerId(api)
    const previous = doc.getIn(['providers', id])

    if (doc.hasIn(['providers', id]) && !isManaged(id, previous)) {
      throw new Error('MaaS 提供方配置存在归属或覆盖冲突，请检查配置后重试。')
    }

    const entry = isMap(previous) ? previous : doc.createNode({})

    if (!isMap(entry)) {
      throw new Error('MaaS 提供方配置无效。')
    }

    const oldModels = entry.get('models')

    if (isAlias(oldModels) || (isMap(oldModels) && (oldModels.anchor || hasMerge(oldModels)))) {
      throw new Error('MaaS 模型目录不能使用共享引用或 YAML 合并，请展开配置后重试。')
    }

    const modelOptions = isMap(oldModels) ? oldModels.clone(doc.schema) : new YAMLMap(doc.schema)

    if (!isMap(modelOptions)) {
      throw new Error('MaaS 模型目录无效。')
    }

    const activeNames = new Set(models.map(model => model.name))
    modelOptions.items = modelOptions.items.filter(
      pair => isScalar(pair.key) && typeof pair.key.value === 'string' && activeNames.has(pair.key.value)
    )

    for (const model of models) {
      const previousOptions = modelOptions.get(model.name)

      if (
        isAlias(previousOptions) ||
        (isMap(previousOptions) && (previousOptions.anchor || hasMerge(previousOptions)))
      ) {
        throw new Error('MaaS 模型选项不能使用共享引用或 YAML 合并，请展开配置后重试。')
      }

      const options = isMap(previousOptions) ? previousOptions : new YAMLMap(doc.schema)

      if (model.contextWindow === undefined) {
        options.delete('context_length')
      } else {
        options.set('context_length', model.contextWindow)
      }

      if (model.vision === true) {
        options.set('supports_vision', true)
      } else if (model.vision === false) {
        options.delete('supports_vision')
      }

      modelOptions.set(model.name, options)
    }

    entry.set('name', `MaaS · ${models[0].name} · ${id.slice(-8)}`)
    entry.set('api', api)
    entry.set('key_env', MAAS_MODEL_KEY_ENV)
    // 原版设置保存等价字段后，统一为托管写法，避免两套地址或协议互相覆盖。
    entry.delete('base_url')
    entry.delete('api_mode')
    entry.set('transport', 'chat_completions')
    entry.set('discover_models', false)
    entry.set('models', modelOptions)

    if (!entry.has('default_model')) {
      entry.set('default_model', models.find(model => model === main)?.name ?? models[0].name)
    }

    doc.setIn(['providers', id], entry)
  }

  if (isMap(providers)) {
    for (const pair of [...providers.items]) {
      const id = isScalar(pair.key) ? pair.key.value : null

      if (typeof id === 'string' && !activeIds.has(id) && isManaged(id, pair.value)) {
        providers.delete(id)
      }
    }
  }

  if (!existing) {
    doc.set('model', { provider: `custom:${providerId(main.baseUrl)}`, default: main.name })
  }

  // 默认不借用本机其他应用的登录；用户显式配置和共享节点保持原样。
  const auth = doc.get('auth')

  if (!doc.has('auth')) {
    doc.set('auth', { adopt_external_logins: false })
  } else if (isMap(auth) && !auth.anchor && !hasMerge(auth) && !auth.has('adopt_external_logins')) {
    auth.set('adopt_external_logins', false)
  }

  const next = doc.toString({ lineWidth: 0 })

  try {
    parseDocument(next, options).toJS()
  } catch {
    throw new Error('更新会影响已有 YAML 引用，原配置保持不变。')
  }

  if (next !== original) {
    try {
      writeSecretFileAtomic(file, next, { encoding: 'utf8' })
    } catch (error) {
      throw new Error('无法保存账号模型配置，原配置保持不变。', { cause: error })
    }
  }
}
