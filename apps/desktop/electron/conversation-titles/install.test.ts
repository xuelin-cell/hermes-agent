import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { installAccountTitlePlugins, installTitlePlugin } from './install'
const appRoot = fileURLToPath(new URL('../../', import.meta.url))

describe('受管标题扩展安装', () => {
  it('普通Home和项目Home隔离，保留用户模型设置并关闭原生命名', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'titles-install-'))

    try {
      for (const relative of ['account-a', 'account-a/profiles/project-123', 'account-b']) {
        const home = path.join(root, relative)
        fs.mkdirSync(home, { recursive: true })
        fs.writeFileSync(
          path.join(home, 'config.yaml'),
          'model:\n  default: existing-model\nplugins:\n  enabled: [existing-plugin]\n'
        )
        installTitlePlugin(home, appRoot)
        const marker = path.join(home, 'plugin-data/uniwork-titles/enabled-at')
        const enabledAt = fs.readFileSync(marker, 'utf8')
        expect(Number(enabledAt)).toBeGreaterThan(0)
        installTitlePlugin(home, appRoot)
        expect(fs.readFileSync(marker, 'utf8')).toBe(enabledAt)
        const config = parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'))
        expect(config.model.default).toBe('existing-model')
        expect(config.auxiliary.title_generation.enabled).toBe(false)
        expect(config.plugins.enabled).toEqual(['existing-plugin', 'uniwork-titles'])
        expect(fs.existsSync(path.join(home, 'plugins/uniwork-titles/dashboard/plugin_api.py'))).toBe(true)
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('共享后端启动前覆盖已有受管项目，忽略非Profile目录', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'titles-multiplex-'))

    try {
      const project = path.join(root, 'profiles/project-a'),
        other = path.join(root, 'profiles/not-a-profile')

      fs.mkdirSync(project, { recursive: true })
      fs.mkdirSync(other, { recursive: true })
      fs.writeFileSync(path.join(project, 'profile.yaml'), 'name: project-a\n')
      installAccountTitlePlugins(root, appRoot)
      expect(parse(fs.readFileSync(path.join(project, 'config.yaml'), 'utf8')).auxiliary.title_generation.enabled).toBe(
        false
      )
      expect(fs.existsSync(path.join(other, 'config.yaml'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('显式停用扩展不会恢复Hermes模型请求，非法映射不部分改写配置', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'titles-disabled-'))

    try {
      const file = path.join(root, 'config.yaml')
      fs.writeFileSync(file, 'plugins:\n  disabled: [uniwork-titles]\n')
      installTitlePlugin(root, appRoot)
      const config = parse(fs.readFileSync(file, 'utf8'))
      expect(config.plugins.enabled).toBeUndefined()
      expect(config.auxiliary.title_generation.enabled).toBe(false)
      const invalid = 'auxiliary: invalid\n'
      fs.writeFileSync(file, invalid)
      expect(() => installTitlePlugin(root, appRoot)).toThrow()
      expect(fs.readFileSync(file, 'utf8')).toBe(invalid)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
