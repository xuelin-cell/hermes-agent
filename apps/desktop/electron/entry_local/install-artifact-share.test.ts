import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'
import { parse } from 'yaml'

import { installArtifactSharePlugin } from './install-artifact-share'

test('新账号自动安装分享插件并保留原有配置', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'share-install-'))

  try {
    const home = path.join(root, 'home')
    const app = path.join(root, 'app')
    fs.mkdirSync(home)
    fs.mkdirSync(path.join(app, 'assets', 'artifact-share-plugin'), { recursive: true })
    fs.writeFileSync(path.join(app, 'assets', 'artifact-share-plugin', 'plugin.yaml'), 'name: desktop-artifact-share\n')
    fs.writeFileSync(path.join(home, 'config.yaml'), 'agent:\n  max_turns: 25\nplugins:\n  enabled: [existing]\n')

    installArtifactSharePlugin(home, app)
    installArtifactSharePlugin(home, app)

    const config = parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'))
    assert.equal(config.agent.max_turns, 25)
    assert.deepEqual(config.plugins.enabled, ['existing', 'desktop-artifact-share'])
    assert.equal(fs.existsSync(path.join(home, 'plugins', 'desktop-artifact-share', 'plugin.yaml')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('空配置的账号也能自动启用插件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'share-install-'))

  try {
    const home = path.join(root, 'home')
    const app = path.join(root, 'app')
    fs.mkdirSync(home)
    fs.mkdirSync(path.join(app, 'assets', 'artifact-share-plugin'), { recursive: true })
    fs.writeFileSync(path.join(app, 'assets', 'artifact-share-plugin', 'plugin.yaml'), 'name: desktop-artifact-share\n')
    installArtifactSharePlugin(home, app)
    assert.deepEqual(parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).plugins.enabled, ['desktop-artifact-share'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
