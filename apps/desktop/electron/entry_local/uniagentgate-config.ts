import fs from 'node:fs'
import path from 'node:path'

import { isMap, isScalar, isSeq, type Node, parseDocument } from 'yaml'

import { writeSecretFileAtomic } from '../hardening'
import type { UniAgentGateUpdate } from '../login/uniagentgate'

import { enableDesktopPlugins } from './desktop-plugins-config'
import { writeAccountSecret } from './model-key'

const SECRET = 'UNIAGENTGATE_AGENT_SK'
const OPTIONS = { version: '1.1' as const, intAsBigInt: true, prettyErrors: false, logLevel: 'silent' as const }

/** 只维护已认证账号的个人 5G 绑定；缺失/坏响应不改文件，无套餐不撤销 5G。 */
export function updateUniAgentGateConfig(home: string, update: UniAgentGateUpdate): void {
  if (update.status !== 'available' && update.status !== 'clear') {
    return
  }

  const file = path.join(home, 'config.yaml')
  const existing = fs.lstatSync(file, { throwIfNoEntry: false })

  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error('5G 账号配置不是普通文件。')
  }

  const original = existing ? fs.readFileSync(file, 'utf8') : ''
  const doc = parseDocument<Node>(original, OPTIONS)

  if (doc.errors.length || doc.warnings.length || (doc.contents && !isMap(doc.contents))) {
    throw new Error('5G 账号配置无效。')
  }

  if (!doc.contents) {
    doc.contents = doc.createNode({})
  }

  // 修改路径上的别名和 YAML 合并可能影响其他 Profile/平台，拒绝后保留原文件。
  for (const keys of [
    [],
    ['platforms'],
    ['platforms', 'uniagentgate'],
    ['display'],
    ['display', 'platforms'],
    ['display', 'platforms', 'uniagentgate']
  ] as string[][]) {
    const node = keys.length ? doc.getIn(keys, true) : doc.contents

    if (
      node !== undefined &&
      (!isMap(node) || node.anchor || node.items.some(pair => isScalar(pair.key) && typeof pair.key.value === 'symbol'))
    ) {
      throw new Error('5G 配置必须使用独立 YAML 映射。')
    }

    if (node === undefined) {
      doc.setIn(keys, doc.createNode({}))
    }
  }

  const set = (key: string, value: unknown) => doc.setIn(['platforms', 'uniagentgate', key], doc.createNode(value))

  if (update.status === 'clear') {
    set('enabled', false)
    doc.deleteIn(['platforms', 'uniagentgate', 'gateway_url'])
    doc.deleteIn(['platforms', 'uniagentgate', 'agent_id'])
    doc.deleteIn(['platforms', 'uniagentgate', 'allow_from'])
  } else {
    set('gateway_url', update.binding.gatewayUrl)
    set('agent_id', update.binding.agentId)
    set('gateway_restart_notification', false)
    set('typing_indicator', false)

    // 个人 Agent 连接由 SK 鉴权；上游发送者可能是 sa_ 标识，不是登录手机号。
    set('enabled', true)

    for (const [key, value] of Object.entries({
      streaming: false,
      tool_progress: 'off',
      show_reasoning: false,
      interim_assistant_messages: false,
      long_running_notifications: false,
      busy_ack_detail: false,
      busy_steer_ack_enabled: false
    })) {
      doc.setIn(['display', 'platforms', 'uniagentgate', key], doc.createNode(value))
    }
  }

  // 两个文件跨进程读：SK 先写，只有配置提交后才允许启动；失败不会启动半准备环境。
  const next = doc.toString({ lineWidth: 0 })
  writeAccountSecret(home, SECRET, update.status === 'available' ? update.binding.agentSk : null)

  if (next !== original) {
    writeSecretFileAtomic(file, next, { encoding: 'utf8' })
  }

  if (update.status === 'available') {
    enableDesktopPlugins(home, ['uniagentgate'])
  }
}

/** 安装发行包自带插件；只写当前账号目录，Python 不从 asar 内导入。 */
export function installUniAgentGatePlugin(home: string, appRoot: string): boolean {
  const config = path.join(home, 'config.yaml')

  if (!fs.existsSync(config)) {
    return false
  }

  const doc = parseDocument(fs.readFileSync(config, 'utf8'), OPTIONS)

  if (doc.errors.length || doc.warnings.length) {
    throw new Error('5G 账号配置无效。')
  }

  if (!doc.hasIn(['platforms', 'uniagentgate'])) {
    return false
  }

  const source = path.join(appRoot, 'assets', 'uniagentgate-plugin')
  const destination = path.join(home, 'plugins', 'uniagentgate')
  const parent = path.dirname(destination)

  for (const directory of [parent, destination]) {
    const item = fs.lstatSync(directory, { throwIfNoEntry: false })

    if (item && (!item.isDirectory() || item.isSymbolicLink())) {
      throw new Error('5G 插件目录无效。')
    }
  }

  if (!fs.statSync(path.join(source, 'plugin.yaml')).isFile()) {
    throw new Error('发行包缺少 5G 消息插件。')
  }

  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  fs.cpSync(source, destination, { recursive: true, force: true })

  const enabled = doc.getIn(['plugins', 'enabled'])
  const disabled = doc.getIn(['plugins', 'disabled'])

  const includes = (value: unknown) =>
    isSeq(value) && value.items.some(item => isScalar(item) && item.value === 'uniagentgate')

  return doc.getIn(['platforms', 'uniagentgate', 'enabled']) === true && includes(enabled) && !includes(disabled)
}
