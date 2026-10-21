// desktop-mt: 安装版后端从 python-plugins 发现插件；内置套件只在打包时拉进 agent-payload 快照，
// 所以完整包要把它们一起放进 python-plugins，否则装好后 autoseed 找不到包。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'

import { payloadBundledKits, stagePythonPlugins } from './stage-python-plugins.mjs'

const source = path.resolve(import.meta.dirname, '../../..')

test('完整包把 agent-payload 里的内置套件放进 python-plugins，其他情况不放', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-kits-'))

  try {
    const build = path.join(root, 'build')
    const stamp = path.join(build, 'install-stamp.json')
    const kits = path.join(build, 'agent-payload', 'hermes-agent', 'plugins', 'uniwork-kits', 'bundled')
    const bundled = { payload: 'bundled', runtime: { repoDir: 'hermes-agent' } }

    assert.equal(payloadBundledKits(stamp, bundled), null, '这次没带内置套件')
    fs.mkdirSync(path.join(kits, 'uniwork-bundled', 'plugins'), { recursive: true })
    fs.writeFileSync(path.join(kits, 'uniwork-bundled', 'plugins', 'good-kit.zip'), 'zip')
    fs.writeFileSync(path.join(kits, 'uniwork-bundled', 'source.json'), '{}')
    assert.equal(payloadBundledKits(stamp, bundled), kits)
    assert.equal(payloadBundledKits(stamp, { payload: 'light' }), null)
    assert.equal(payloadBundledKits(stamp, { payload: 'bundled' }), null)

    const staged = stagePythonPlugins({ source, out: path.join(root, 'dist'), bundledKits: payloadBundledKits(stamp, bundled) })
    const zip = path.join(staged, 'uniwork-kits', 'bundled', 'uniwork-bundled', 'plugins', 'good-kit.zip')
    assert.equal(fs.readFileSync(zip, 'utf8'), 'zip')
    assert.equal(fs.existsSync(path.join(staged, 'uniwork-kits', 'autoseed.py')), true)

    const plain = stagePythonPlugins({ source, out: path.join(root, 'dev') })
    assert.equal(fs.existsSync(path.join(plain, 'uniwork-kits', 'bundled')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
