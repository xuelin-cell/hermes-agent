import fs from 'node:fs'
import path from 'node:path'

import { isMap, isSeq, parseDocument } from 'yaml'

import { writeSecretFileAtomic } from '../hardening'

import { copyAppTree } from './copy-app-tree'

const NAME = 'desktop-artifact-share'

/** 账号后端启动前安装定制发行附带的分享插件并启用其工具。 */
export function installArtifactSharePlugin(home: string, appRoot: string): void {
  const source = path.join(appRoot, 'assets', 'artifact-share-plugin')
  const destination = path.join(home, 'plugins', NAME)
  const sourceInfo = fs.statSync(path.join(source, 'plugin.yaml'))

  if (!sourceInfo.isFile()) {
    throw new Error('发行包缺少产物分享插件。')
  }

  const destinationInfo = fs.lstatSync(destination, { throwIfNoEntry: false })

  if (destinationInfo?.isSymbolicLink() || (destinationInfo && !destinationInfo.isDirectory())) {
    throw new Error('分享插件目录无效。')
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  copyAppTree(source, destination)

  const config = path.join(home, 'config.yaml')
  const existing = fs.lstatSync(config, { throwIfNoEntry: false })

  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error('账号配置文件无效。')
  }

  const doc = parseDocument(existing ? fs.readFileSync(config, 'utf8') : '', { version: '1.1', intAsBigInt: true })

  if (doc.errors.length || doc.warnings.length || (doc.contents && !isMap(doc.contents))) {
    throw new Error('账号配置文件无效，无法启用分享插件。')
  }

  if (!doc.contents) {
    doc.contents = parseDocument('{}', { version: '1.1', intAsBigInt: true }).contents
  }

  const plugins = doc.get('plugins', true)

  if (plugins && !isMap(plugins)) {
    throw new Error('账号插件配置无效。')
  }

  if (!plugins) {
    doc.set('plugins', doc.createNode({}))
  }

  const enabled = isMap(plugins) ? plugins.get('enabled', true) : undefined

  if (enabled && !isSeq(enabled)) {
    throw new Error('账号插件启用列表无效。')
  }

  const current: unknown = isSeq(enabled) ? enabled.toJSON() : undefined

  if (current && (!Array.isArray(current) || !current.every(item => typeof item === 'string'))) {
    throw new Error('账号插件启用列表无效。')
  }

  const names: string[] = Array.isArray(current) ? current : []

  if (names.includes(NAME)) {
    return
  }

  doc.setIn(['plugins', 'enabled'], [...names, NAME])
  writeSecretFileAtomic(config, String(doc), { encoding: 'utf8' })
}
