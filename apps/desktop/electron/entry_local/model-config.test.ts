import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'
import { parseDocument, stringify, type YAMLMap } from 'yaml'

import type { MaasPlan } from '../login/plan'

import { MAAS_MODEL_KEY_ENV, mergeMaasModelConfig } from './model-config'

const catalog: MaasPlan = {
  apiKey: 'must-not-be-in-yaml',
  models: [
    { id: 'a', name: 'shared-name', baseUrl: 'https://models.invalid/plan/a/v1' },
    { id: 'b', name: 'shared-name', baseUrl: 'https://models.invalid/plan/b/v1' },
    { id: 'c', name: 'other-model', baseUrl: 'https://models.invalid/plan/a/v1' }
  ],
  mainModelIndex: 1
}

/** 重新解析实际文件，使用与原版 PyYAML 一致的 1.1 语义保留大整数。 */
function readConfig(file: string) {
  return parseDocument(fs.readFileSync(file, 'utf8'), { version: '1.1', intAsBigInt: true }).toJS()
}

it('首次按端点合并模型，固定默认引用；重排重复准备不增加 provider，不落盘模型 Key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-model-new-'))
  const file = path.join(home, 'config.yaml')

  try {
    mergeMaasModelConfig(home, catalog)
    const config = readConfig(file)
    const providers = Object.entries(config.providers) as [string, any][]
    expect(providers).toHaveLength(2)
    expect(new Set(providers.map(([, value]) => value.name)).size).toBe(2)
    expect(new Set(providers.map(([, value]) => value.api))).toEqual(
      new Set(catalog.models.map(model => model.baseUrl))
    )

    for (const [id, provider] of providers) {
      expect(id).toMatch(/^desktop-mt-maas-[a-f0-9]{64}$/)
      expect(provider.key_env).toBe(MAAS_MODEL_KEY_ENV)
      expect(provider.transport).toBe('chat_completions')
      expect(provider.discover_models).toBe(false)
      expect(Object.keys(provider.models)).toEqual(
        catalog.models.filter(model => model.baseUrl === provider.api).map(model => model.name)
      )
    }

    const mainId = providers.find(([, value]) => value.api === catalog.models[1].baseUrl)![0]
    expect(config.model).toEqual({ provider: `custom:${mainId}`, default: 'shared-name' })
    const before = fs.readFileSync(file, 'utf8')
    expect(before).not.toContain(catalog.apiKey)
    expect(fs.existsSync(path.join(home, '.env'))).toBe(false)
    mergeMaasModelConfig(home, catalog)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    mergeMaasModelConfig(home, { models: [catalog.models[2], catalog.models[0], catalog.models[1]], mainModelIndex: 2 })
    expect(readConfig(file).model).toEqual(config.model)
    expect(Object.keys(readConfig(file).providers).sort()).toEqual(Object.keys(config.providers).sort())
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('既有个人默认、MCP、Skills、注释、未知字段及模型选项保留；套餐刷新只移除托管旧端点', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-model-user-'))
  const file = path.join(home, 'config.yaml')

  const original = `# 用户说明保留
model: {provider: 'custom:personal', default: my-model}
providers:
  personal:
    name: My provider
    api: https://personal.invalid/v1
    key_env: PERSONAL_KEY
    models: {my-model: {context_length: 8192}}
mcp_servers: {custom: {command: local-tool}}
skills: {enabled: [my-skill]}
shared: &setting {unknown: yes}
other: *setting
future_counter: 900719925474099312345
`

  try {
    fs.writeFileSync(file, original)
    const personal = readConfig(file)
    mergeMaasModelConfig(home, catalog)
    let config = readConfig(file)

    for (const key of Object.keys(personal)) {
      if (key !== 'providers') {
        expect(config[key]).toEqual(personal[key])
      }
    }

    expect(config.providers.personal).toEqual(personal.providers.personal)
    expect(fs.readFileSync(file, 'utf8')).toContain('# 用户说明保留')
    const id = Object.keys(config.providers).find(key => config.providers[key].api === catalog.models[0].baseUrl)!
    const doc = parseDocument(fs.readFileSync(file, 'utf8'), { version: '1.1', intAsBigInt: true })
    doc.setIn(['providers', id, 'models', 'shared-name'], { context_length: 16384, extra_option: 'keep' })
    doc.setIn(['providers', id, 'default_model'], 'other-model')
    doc.setIn(['providers', id, 'timeout'], 90)
    const modelOptions = doc.getIn(['providers', id, 'models']) as YAMLMap
    modelOptions.commentBefore = ' 模型选项说明保留'
    fs.writeFileSync(file, doc.toString())
    mergeMaasModelConfig(home, {
      models: [catalog.models[0], { ...catalog.models[2], name: 'new-model' }],
      mainModelIndex: 0
    })
    config = readConfig(file)
    expect(Object.keys(config.providers)).toEqual(['personal', id])
    expect(config.providers[id].models).toEqual({
      'shared-name': { context_length: 16384n, extra_option: 'keep' },
      'new-model': {}
    })
    expect(config.providers[id].default_model).toBe('other-model')
    expect(config.providers[id].timeout).toBe(90n)
    expect(config.model).toEqual(personal.model)
    expect(config.future_counter).toEqual(personal.future_counter)
    expect(config.other).toEqual(personal.other)
    const before = fs.readFileSync(file, 'utf8')
    expect(before).toContain('# 模型选项说明保留')
    mergeMaasModelConfig(home, {
      models: [catalog.models[0], { ...catalog.models[2], name: 'new-model' }],
      mainModelIndex: 0
    })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('坏文件、归属冲突、共享配置及写入失败均拒绝，保留原字节；链接不写穿到其他目录', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-model-fail-'))
  const file = path.join(home, 'config.yaml')

  try {
    mergeMaasModelConfig(home, catalog)
    const config = readConfig(file)
    const id = Object.keys(config.providers)[0]
    const managed = config.providers[id]

    for (const invalid of [
      'private-secret: [broken',
      '- not-a-map\n',
      'providers: invalid\n',
      'duplicate: a\nduplicate: b\n',
      'other: *missing\n',
      '&root\nproviders: {}\nother: *root\n',
      'shared: &base {providers: {personal: {api: other}}}\n<<: *base\n',
      'providers: &shared {}\nother: *shared\n',
      stringify({ providers: { [id]: { ...managed, key_env: 'PERSONAL_KEY' } } }),
      stringify({ providers: { [id]: { ...managed, api_key: 'private-user-key' } } }),
      `providers:\n  ${id}:\n    name: &label Shared\n    api: ${managed.api}\n    key_env: ${MAAS_MODEL_KEY_ENV}\nother: *label\n`,
      `shared: &list {}\nproviders:\n  ${id}:\n    api: ${managed.api}\n    key_env: ${MAAS_MODEL_KEY_ENV}\n    models: *list\n`
    ]) {
      fs.writeFileSync(file, invalid)
      expect(() => mergeMaasModelConfig(home, catalog)).toThrow()
      expect(fs.readFileSync(file, 'utf8')).toBe(invalid)
    }

    fs.writeFileSync(file, 'model: {provider: personal, default: my-model}\n')
    const before = fs.readFileSync(file, 'utf8')
    fs.mkdirSync(`${file}.tmp`)
    expect(() => mergeMaasModelConfig(home, catalog)).toThrow('无法保存账号模型配置，原配置保持不变。')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    fs.rmdirSync(`${file}.tmp`)
    fs.unlinkSync(file)
    const outside = path.join(home, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'keep.yaml'), 'keep-user-data')
    fs.symlinkSync(outside, file, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => mergeMaasModelConfig(home, catalog)).toThrow('普通文件')
    expect(fs.readFileSync(path.join(outside, 'keep.yaml'), 'utf8')).toBe('keep-user-data')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
