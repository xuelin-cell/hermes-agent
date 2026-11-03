import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import { markModelVisionFlags } from './model-vision-flags'

const MAIN = [
  '# 用户说明',
  'providers:',
  '  uw-3adbaebc:',
  '    name: DeepSeek Flash',
  '    model: deepseek-flash',
  '    models:',
  '      deepseek-flash:',
  '        context_length: 200000',
  '    input_modalities:',
  '      - text',
  '  uw-nomodels:',
  '    model: kimi',
  '  uw-explicit:',
  '    model: gpt',
  '    models: {gpt: {supports_vision: true}, gpt-mini: {supports_vision: false}}',
  '    input_modalities: [text]',
  '  uw-vision:',
  '    model: qwen-vl',
  '    input_modalities: [text, image]',
  '  desktop-mt-maas-x:',
  '    models: {deepseek-v4-flash: {context_length: 300000}, deepseek-v4.1-flash: {supports_vision: true}}',
  ''
].join('\n')

/** 建一个临时账号目录：主配置加若干专家配置，返回目录。 */
function account(main: string, profiles: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-vision-flags-'))
  fs.writeFileSync(path.join(home, 'config.yaml'), main)

  for (const [name, yaml] of Object.entries(profiles)) {
    fs.mkdirSync(path.join(home, 'profiles', name), { recursive: true })
    fs.writeFileSync(path.join(home, 'profiles', name, 'config.yaml'), yaml)
  }

  return home
}

/** 读回某份配置的 providers。 */
function providersOf(file: string) {
  return parse(fs.readFileSync(file, 'utf8')).providers
}

it('没写明的模型补 false、勾了图片的补 true，已写明的不动，主配置和专家配置都补，重复执行不写盘', () => {
  const home = account(MAIN, { 'equity-research': MAIN, 'empty-profile': 'model: {default: x}\n' })

  try {
    markModelVisionFlags(home)

    for (const file of [path.join(home, 'config.yaml'), path.join(home, 'profiles', 'equity-research', 'config.yaml')]) {
      const providers = providersOf(file)
      expect(providers['uw-3adbaebc'].models).toEqual({
        'deepseek-flash': { context_length: 200000, supports_vision: false }
      })
      expect(providers['uw-nomodels'].models).toEqual({ kimi: { supports_vision: false } })
      expect(providers['uw-explicit'].models).toEqual({
        gpt: { supports_vision: true },
        'gpt-mini': { supports_vision: false }
      })
      expect(providers['uw-vision'].models).toEqual({ 'qwen-vl': { supports_vision: true } })
      expect(providers['desktop-mt-maas-x'].models).toEqual({
        'deepseek-v4-flash': { context_length: 300000, supports_vision: false },
        'deepseek-v4.1-flash': { supports_vision: true }
      })
      expect(fs.readFileSync(file, 'utf8')).toContain('# 用户说明')
    }

    expect(fs.readFileSync(path.join(home, 'profiles', 'empty-profile', 'config.yaml'), 'utf8')).toBe(
      'model: {default: x}\n'
    )

    const rename = vi.spyOn(fs, 'renameSync')

    try {
      markModelVisionFlags(home)
      expect(rename).not.toHaveBeenCalled()
    } finally {
      rename.mockRestore()
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('配置无效、用了共享引用或输入类型看不懂时原样不动；一个专家配置坏了不影响其他助手，也不报错', () => {
  const broken = 'providers: [\n'
  const shared = 'shared: &m {kimi: {context_length: 1}}\nproviders:\n  uw-a: {model: kimi, models: *m}\n'
  const odd = 'providers:\n  uw-a: {model: kimi, input_modalities: text}\n'
  const home = account(broken, { 'a-shared': shared, 'b-odd': odd, 'c-good': MAIN })
  fs.mkdirSync(path.join(home, 'profiles', '..hidden'))
  fs.mkdirSync(path.join(home, 'profiles', 'no-config'))

  try {
    expect(() => markModelVisionFlags(home)).not.toThrow()
    expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).toBe(broken)
    expect(fs.readFileSync(path.join(home, 'profiles', 'a-shared', 'config.yaml'), 'utf8')).toBe(shared)
    expect(fs.readFileSync(path.join(home, 'profiles', 'b-odd', 'config.yaml'), 'utf8')).toBe(odd)
    expect(providersOf(path.join(home, 'profiles', 'c-good', 'config.yaml'))['uw-nomodels'].models).toEqual({
      kimi: { supports_vision: false }
    })
    expect(fs.existsSync(path.join(home, 'profiles', 'no-config', 'config.yaml'))).toBe(false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }

  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-vision-flags-'))

  try {
    expect(() => markModelVisionFlags(missing)).not.toThrow()
    expect(fs.existsSync(path.join(missing, 'config.yaml'))).toBe(false)
  } finally {
    fs.rmSync(missing, { recursive: true, force: true })
  }
})
