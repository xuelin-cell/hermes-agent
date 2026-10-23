import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import { MAAS_MODEL_KEY_ENV } from './model-config'
import { updateUniaiToolkitConfig } from './uniai-toolkit-config'

it('按套餐新建和更新内置记录，保留停用、工具过滤和其他服务，重复或失败不写盘，空套餐只删除内置项', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-uniai-config-'))
  const file = path.join(home, 'config.yaml')
  const rename = vi.spyOn(fs, 'renameSync')

  try {
    updateUniaiToolkitConfig(home, 'empty')
    expect(fs.existsSync(file)).toBe(false)
    updateUniaiToolkitConfig(home, 'available')
    const created = parse(fs.readFileSync(file, 'utf8')).mcp_servers['UniAI-Toolkit']
    expect(created).toEqual({
      url: `https://maas.ai-yuanjing.com/app/mcp-server/mcp?key=\${${MAAS_MODEL_KEY_ENV}}&client_id=UniWork`,
      timeout: 1000
    })

    const original =
      '# 用户说明\nmodel: {provider: personal}\nmcp_servers:\n' +
      '  custom: {command: node}\n  UniAI-Toolkit:\n    url: https://old.invalid\n' +
      '    timeout: 30\n    enabled: false # 用户停用\n    tools: {exclude: [danger]}\n'

    fs.writeFileSync(file, original)
    updateUniaiToolkitConfig(home, 'available')
    const saved = fs.readFileSync(file, 'utf8')
    const config = parse(saved)
    expect(config.model).toEqual({ provider: 'personal' })
    expect(config.mcp_servers.custom).toEqual({ command: 'node' })
    expect(config.mcp_servers['UniAI-Toolkit']).toEqual({ ...created, enabled: false, tools: { exclude: ['danger'] } })
    expect(saved).toContain('# 用户说明')
    expect(saved).toContain('# 用户停用')
    rename.mockClear()
    updateUniaiToolkitConfig(home, 'available')
    updateUniaiToolkitConfig(home, 'failed')
    expect(rename).not.toHaveBeenCalled()
    expect(fs.readFileSync(file, 'utf8')).toBe(saved)
    updateUniaiToolkitConfig(home, 'empty')
    expect(parse(fs.readFileSync(file, 'utf8')).mcp_servers).toEqual({ custom: { command: 'node' } })
  } finally {
    vi.restoreAllMocks()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('无效配置报错但不覆盖，共享或非映射 MCP 保持原状且不阻断', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-uniai-shared-'))
  const file = path.join(home, 'config.yaml')

  try {
    for (const invalid of ['mcp_servers: [broken', '- not-a-config-map\n']) {
      fs.writeFileSync(file, invalid)
      expect(() => updateUniaiToolkitConfig(home, 'available')).toThrow()
      expect(fs.readFileSync(file, 'utf8')).toBe(invalid)
      expect(() => updateUniaiToolkitConfig(home, 'failed')).not.toThrow()
    }

    for (const shared of [
      'mcp_servers: []\n',
      'shared: &all {UniAI-Toolkit: {url: old}}\nmcp_servers: *all\n',
      'mcp_servers:\n  UniAI-Toolkit: &tool {url: old}\nother: *tool\n',
      'shared: &tool {url: old}\nmcp_servers:\n  UniAI-Toolkit: {<<: *tool, enabled: false}\n'
    ]) {
      fs.writeFileSync(file, shared)
      expect(() => updateUniaiToolkitConfig(home, 'available')).not.toThrow()
      expect(() => updateUniaiToolkitConfig(home, 'empty')).not.toThrow()
      expect(fs.readFileSync(file, 'utf8')).toBe(shared)
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('有套餐时隐藏 Hermes 自带的看图工具组，保留用户已停用的其他工具组，无套餐或共享引用时不动', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-uniai-vision-'))
  const file = path.join(home, 'config.yaml')
  const rename = vi.spyOn(fs, 'renameSync')

  try {
    updateUniaiToolkitConfig(home, 'available')
    expect(parse(fs.readFileSync(file, 'utf8')).agent).toEqual({ disabled_toolsets: ['vision'] })

    for (const [original, expected] of [
      ['agent:\n  max_turns: 9\n  disabled_toolsets: [web] # 用户停用\n', ['web', 'vision']],
      ['agent:\n  disabled_toolsets: connections\n', ['connections', 'vision']],
      ['agent:\n  disabled_toolsets:\n    - vision\n    - web\n', ['vision', 'web']]
    ] as const) {
      fs.writeFileSync(file, original)
      updateUniaiToolkitConfig(home, 'available')
      const saved = fs.readFileSync(file, 'utf8')
      expect(parse(saved).agent.disabled_toolsets).toEqual(expected)
      rename.mockClear()
      updateUniaiToolkitConfig(home, 'available')
      expect(rename).not.toHaveBeenCalled()
      expect(fs.readFileSync(file, 'utf8')).toBe(saved)
    }

    // 同一 agent 段里的其他设置和注释保留。
    fs.writeFileSync(file, 'agent:\n  max_turns: 9\n  disabled_toolsets: [web] # 用户停用\n')
    updateUniaiToolkitConfig(home, 'available')
    expect(parse(fs.readFileSync(file, 'utf8')).agent.max_turns).toBe(9)
    expect(fs.readFileSync(file, 'utf8')).toContain('# 用户停用')

    // 无套餐不加；agent 是共享引用时也不改，免得影响别处。
    const noPlan = 'model: {provider: x}\n'
    fs.writeFileSync(file, noPlan)
    updateUniaiToolkitConfig(home, 'empty')
    expect(fs.readFileSync(file, 'utf8')).toBe(noPlan)
    fs.writeFileSync(file, 'base: &a {max_turns: 3}\nagent: *a\n')
    updateUniaiToolkitConfig(home, 'available')
    expect(parse(fs.readFileSync(file, 'utf8')).agent).toEqual({ max_turns: 3 })
  } finally {
    vi.restoreAllMocks()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('为翻译、播客和视频补充外层等待预算，保留其他工具和用户覆盖，重复更新不写盘', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-background-timeouts-'))
  const file = path.join(home, 'config.yaml')

  try {
    fs.writeFileSync(file, 'timeouts:\n  tools:\n    sequential_call: 90\n    sequential_calls:\n      custom: 42\n      mcp__UniAI_Toolkit__doc_translate: 720\n')
    updateUniaiToolkitConfig(home, 'available')
    const saved = fs.readFileSync(file, 'utf8')
    expect(parse(saved).timeouts.tools).toEqual({
      sequential_call: 90,
      sequential_calls: {
        custom: 42,
        mcp__UniAI_Toolkit__doc_translate: 720,
        mcp__UniAI_Toolkit__ai_podcast_generate: 930,
        mcp__UniAI_Toolkit__txt2vid_generate: 390,
        mcp__UniAI_Toolkit__img2vid_generate: 390
      }
    })
    updateUniaiToolkitConfig(home, 'available')
    expect(fs.readFileSync(file, 'utf8')).toBe(saved)
    fs.writeFileSync(file, 'base: &t {tools: {sequential_call: 90}}\ntimeouts: *t\n')
    updateUniaiToolkitConfig(home, 'available')
    expect(parse(fs.readFileSync(file, 'utf8')).timeouts).toEqual({ tools: { sequential_call: 90 } })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('旧版写入的 630 秒和 600 秒升级为对齐 UniWork 的预算，视频上用户写的 630 保留', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-background-upgrade-'))
  const file = path.join(home, 'config.yaml')

  try {
    fs.writeFileSync(
      file,
      'mcp_servers:\n  UniAI-Toolkit:\n    url: https://old.invalid\n    timeout: 600\n' +
        'timeouts:\n  tools:\n    sequential_calls:\n' +
        '      mcp__UniAI_Toolkit__doc_translate: 630\n' +
        '      mcp__UniAI_Toolkit__ai_podcast_generate: 630\n' +
        '      mcp__UniAI_Toolkit__txt2vid_generate: 630\n'
    )
    updateUniaiToolkitConfig(home, 'available')
    const config = parse(fs.readFileSync(file, 'utf8'))
    expect(config.mcp_servers['UniAI-Toolkit'].timeout).toBe(1000)
    expect(config.timeouts.tools.sequential_calls).toEqual({
      mcp__UniAI_Toolkit__doc_translate: 1030,
      mcp__UniAI_Toolkit__ai_podcast_generate: 930,
      mcp__UniAI_Toolkit__txt2vid_generate: 630,
      mcp__UniAI_Toolkit__img2vid_generate: 390
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
