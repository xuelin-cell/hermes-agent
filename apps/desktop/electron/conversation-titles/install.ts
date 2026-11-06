import fs from 'node:fs'
import path from 'node:path'

import { isAlias, isMap, isScalar, isSeq, type Node, parseDocument } from 'yaml'

import { copyAppTree } from '../entry_local/copy-app-tree'
import { writeSecretFileAtomic } from '../hardening'
const NAME = 'uniwork-titles'

/** 受管后端启动前安装产品扩展并关闭旧命名；不改Python核心，不运行用户配置中的备用模型。 */
export function installTitlePlugin(home: string, appRoot: string): void {
  const source = path.join(appRoot, 'assets', 'uniwork-titles')

  if (!fs.statSync(path.join(source, 'plugin.yaml')).isFile()) {
    throw new Error('缺少会话标题扩展')
  }

  const destination = path.join(home, 'plugins', NAME)

  for (const candidate of [path.join(home, 'plugins'), destination]) {
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false })

    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error('标题扩展目录无效')
    }
  }

  const file = path.join(home, 'config.yaml')
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })

  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error('标题配置文件无效')
  }

  const original = stat ? fs.readFileSync(file, 'utf8') : ''
  const doc = parseDocument<Node>(original, { version: '1.1' })

  if (doc.errors.length || doc.warnings.length || (doc.contents && !isMap(doc.contents))) {
    throw new Error('标题配置无效')
  }

  if (!doc.contents) {
    doc.contents = doc.createNode({})
  }

  for (const keys of [[], ['plugins'], ['auxiliary'], ['auxiliary', 'title_generation']]) {
    const value = keys.length ? doc.getIn(keys, true) : doc.contents

    if (
      value != null &&
      (!isMap(value) ||
        value.anchor ||
        value.items.some(pair => isScalar(pair.key) && typeof pair.key.value === 'symbol'))
    ) {
      throw new Error('标题配置不能使用共享映射')
    }
  }

  for (const name of ['enabled', 'disabled']) {
    const value = doc.getIn(['plugins', name], true)

    if (value != null && (!isSeq(value) || value.anchor || value.items.some(isAlias))) {
      throw new Error('插件列表无效')
    }
  }

  const enabled: string[] = doc.toJS()?.plugins?.enabled ?? []
  const disabled: string[] = doc.toJS()?.plugins?.disabled ?? []

  if (![...enabled, ...disabled].every(value => typeof value === 'string')) {
    throw new Error('插件列表无效')
  }

  // 显式停用产品命名时也不能恢复Hermes付费命名，保留输入预览即可。
  if (!doc.has('plugins')) {
    doc.set('plugins', doc.createNode({}))
  }

  if (!disabled.includes(NAME) && !enabled.includes(NAME)) {
    doc.setIn(['plugins', 'enabled'], [...enabled, NAME])
  }

  // YAML 1.1的隐式嵌套setIn会构造!!omap，显式创建普通映射供Python配置读取。
  if (!doc.has('auxiliary')) {
    doc.set('auxiliary', doc.createNode({}))
  }

  if (!doc.hasIn(['auxiliary', 'title_generation'])) {
    doc.setIn(['auxiliary', 'title_generation'], doc.createNode({}))
  }

  doc.setIn(['auxiliary', 'title_generation', 'enabled'], false)
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  copyAppTree(source, destination)
  const next = doc.toString()

  if (next !== original) {
    writeSecretFileAtomic(file, next, { encoding: 'utf8' })
  }

  // 启用时间只创建一次，崩溃恢复不能把历史无标题会话当作本轮新会话批量命名。
  const state = path.join(home, 'plugin-data', NAME)

  for (const candidate of [path.dirname(state), state, path.join(state, 'enabled-at')]) {
    if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('标题状态目录无效')
    }
  }

  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  const marker = path.join(state, 'enabled-at')

  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, String(Date.now() / 1000), { flag: 'wx', mode: 0o600 })
  }
}

/** 多Profile共用单后端时，也要在启动前准备所有已有本机Profile的命名配置。 */
export function installAccountTitlePlugins(home: string, appRoot: string): void {
  installTitlePlugin(home, appRoot)
  const profiles = path.join(home, 'profiles')
  const info = fs.lstatSync(profiles, { throwIfNoEntry: false })

  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    return
  }

  for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) {
      continue
    }

    const profileHome = path.join(profiles, entry.name)
    const marker = fs.lstatSync(path.join(profileHome, 'profile.yaml'), { throwIfNoEntry: false })

    if (marker?.isFile() && !marker.isSymbolicLink()) {
      installTitlePlugin(profileHome, appRoot)
    }
  }
}
