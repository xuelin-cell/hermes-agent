import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import { enableUniworkKits } from './uniwork-kits-config'

it('新账号和已有配置都启用套件插件，保留其他插件和注释，重复执行不写盘', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-kits-config-'))
  const file = path.join(home, 'config.yaml')
  const rename = vi.spyOn(fs, 'renameSync')

  try {
    enableUniworkKits(home)
    expect(parse(fs.readFileSync(file, 'utf8')).plugins).toEqual({ enabled: ['uniwork-kits'] })

    fs.writeFileSync(file, '# 用户说明\nmodel: {provider: personal}\nplugins:\n  enabled:\n  - kanban # 看板\n')
    enableUniworkKits(home)
    const saved = fs.readFileSync(file, 'utf8')
    const config = parse(saved)
    expect(config.model).toEqual({ provider: 'personal' })
    expect(config.plugins.enabled).toEqual(['kanban', 'uniwork-kits'])
    expect(saved).toContain('# 用户说明')
    expect(saved).toContain('# 看板')

    rename.mockClear()
    enableUniworkKits(home)
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
    enableUniworkKits(home)
    expect(fs.readFileSync(file, 'utf8')).toBe(disabled)

    fs.writeFileSync(file, 'plugins: [broken')
    expect(() => enableUniworkKits(home)).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe('plugins: [broken')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
