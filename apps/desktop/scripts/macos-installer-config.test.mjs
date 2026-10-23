import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'
import { validatePreparedBuilderArgs } from './run-electron-builder.mjs'

const require = createRequire(import.meta.url)
const libraryRoot = path.dirname(path.dirname(require.resolve('app-builder-lib')))
const { validateConfiguration } = await import(pathToFileURL(path.join(libraryRoot, 'dist/util/config/config.js')))

// 校验真实配置和入口边界，确保内部测试不会再次跳过签名或允许任意模块。
test('macOS wrapper admits a fixed ad-hoc configuration and retains certificate signing', async () => {
  const script = readFileSync(new URL('../../../build-macos-installer.sh', import.meta.url), 'utf8')
  assert.ok(script.includes("builder_args+=('--internal-test-signing')"))
  const inputs = { target: 'darwin-arm64', formats: ['dmg', 'zip'] }
  const args = ['--mac', 'dmg', 'zip', '-c.extraMetadata.version=0.0.0', '-c.compression=normal', '--publish', 'never']
  validatePreparedBuilderArgs([...args, '--internal-test-signing'], inputs)
  validatePreparedBuilderArgs([...args, '-c.forceCodeSigning=true'], inputs)
  for (const override of ['-c.mac.sign=arbitrary-module', '-c.mac.identity=null', '-c.mac.sign=null']) {
    assert.throws(() => validatePreparedBuilderArgs([...args, override], inputs), /not admitted/)
  }
  assert.throws(() => validatePreparedBuilderArgs(['--win', 'nsis', '--internal-test-signing'], { target: 'win32-x64', formats: ['nsis'] }), /not admitted/)
  const adhoc = require('../electron-builder.adhoc.cjs')
  await validateConfiguration(adhoc, { isEnabled: false })
  assert.equal(adhoc.mac.sign.identity, '-')
  assert.equal(adhoc.afterSign, 'scripts/after-sign-adhoc.mjs')
  const config = require('../electron-builder.config.cjs')
  await validateConfiguration({ ...config, forceCodeSigning: true }, { isEnabled: false })
  assert.equal(typeof config.mac.sign, 'function')
})
