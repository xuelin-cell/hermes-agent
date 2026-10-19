import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import { enableDesktopPlugins } from './desktop-plugins-config'

it('新账号和已有配置都启用两个内置插件，保留其他插件和注释，重复执行不写盘', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-kits-config-'))
  const file = path.join(home, 'config.yaml')
  const rename = vi.spyOn(fs, 'renameSync')

  try {
    enableDesktopPlugins(home)
    expect(parse(fs.readFileSync(file, 'utf8')).plugins).toEqual({ enabled: ['uniwork-kits', 'desktop-deliverables'] })

    fs.writeFileSync(file, '# 用户说明\nmodel: {provider: personal}\nplugins:\n  enabled:\n  - kanban # 看板\n')
    enableDesktopPlugins(home)
    const saved = fs.readFileSync(file, 'utf8')
    const config = parse(saved)
    expect(config.model).toEqual({ provider: 'personal' })
    expect(config.plugins.enabled).toEqual(['kanban', 'uniwork-kits', 'desktop-deliverables'])
    expect(saved).toContain('# 用户说明')
    expect(saved).toContain('# 看板')

    rename.mockClear()
    enableDesktopPlugins(home)
    expect(rename).not.toHaveBeenCalled()
    expect(fs.readFileSync(file, 'utf8')).toBe(saved)
  } finally {
    vi.restoreAllMocks()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('用户停用过就不再打开，配置坏了报错且不覆盖', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-kits-disabled-'))
  const file = path.join(home, 'config.yaml')

  try {
    const disabled = 'plugins:\n  disabled:\n  - uniwork-kits\n'
    fs.writeFileSync(file, disabled)
    enableDesktopPlugins(home)
    expect(parse(fs.readFileSync(file, 'utf8')).plugins).toEqual({
      disabled: ['uniwork-kits'],
      enabled: ['desktop-deliverables']
    })

    const allDisabled = 'plugins:\n  disabled: [uniwork-kits, desktop-deliverables]\n'
    fs.writeFileSync(file, allDisabled)
    enableDesktopPlugins(home)
    expect(fs.readFileSync(file, 'utf8')).toBe(allDisabled)

    fs.writeFileSync(file, 'plugins: [broken')
    expect(() => enableDesktopPlugins(home)).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe('plugins: [broken')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('Profile 只启用交付插件，不顺带开启套件，保留个人配置', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-profile-plugins-'))
  const file = path.join(root, 'config.yaml')
  const original = 'model: personal\nplugins:\n  enabled: [custom]\n  disabled: [uniwork-kits]\n'

  try {
    fs.writeFileSync(file, original)
    enableDesktopPlugins(root, ['desktop-deliverables'])
    expect(parse(fs.readFileSync(file, 'utf8'))).toEqual({
      model: 'personal',
      plugins: { enabled: ['custom', 'desktop-deliverables'], disabled: ['uniwork-kits'] }
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('启用列表被其它配置引用时不改写共享锚点', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-shared-plugins-'))
  const file = path.join(root, 'config.yaml')
  const original = 'plugins:\n  enabled: &shared [custom]\nother: *shared\n'

  try {
    fs.writeFileSync(file, original)
    enableDesktopPlugins(root)
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
