// desktop-mt: 开放连接器在安装版里从 resources/open-connector 运行，要带上自己的 node_modules。
// electron-builder 复制 extraResources 时总会丢掉来源目录顶层的 node_modules，所以这里按它自己的
// FileMatcher 规则走一遍，确认依赖真的会被复制进去。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'

const require = createRequire(import.meta.url)
const desktop = path.resolve(import.meta.dirname, '..')
const { FileMatcher } = await import(
  pathToFileURL(path.resolve(desktop, '../../node_modules/app-builder-lib/dist/fileMatcher.js')).href
)

/** 模拟 electron-builder 的 copyFiles：目录被筛掉就不再往下走。 */
function copied(entry, appDir) {
  const from = path.resolve(appDir, entry.from)
  const resources = path.join(appDir, 'resources')
  const matcher = new FileMatcher(from, path.resolve(resources, entry.to), value => value, entry.filter)
  const filter = matcher.createFilter()
  const out = []
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const stat = fs.statSync(full)
      if (!filter(full, stat)) continue
      if (stat.isDirectory()) walk(full)
      else out.push(path.relative(resources, path.join(matcher.to, path.relative(from, full))).replace(/\\/g, '/'))
    }
  }
  walk(from)
  return out
}

test('开放连接器连同 node_modules 一起进 resources/open-connector', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-connector-resources-'))

  try {
    const service = path.join(root, 'services', 'open-connector')
    for (const file of ['src/server/index.ts', 'node_modules/hono/package.json', 'package.json', 'tests/fixture.test.ts']) {
      fs.mkdirSync(path.dirname(path.join(service, file)), { recursive: true })
      fs.writeFileSync(path.join(service, file), '{}')
    }
    const config = require(path.join(desktop, 'electron-builder.config.cjs'))
    const entry = config.extraResources.find(item => String(item.from).startsWith('services'))
    assert.ok(entry, 'open-connector extraResources entry')

    const files = copied(entry, root)
    assert.ok(files.includes('open-connector/node_modules/hono/package.json'), files.join('\n'))
    assert.ok(files.includes('open-connector/src/server/index.ts'))
    assert.ok(files.includes('open-connector/package.json'))
    assert.ok(!files.some(file => file.includes('/tests/')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
