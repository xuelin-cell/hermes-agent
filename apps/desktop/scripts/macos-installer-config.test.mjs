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

// 用已安装打包器校验入口实际传入的未签名覆盖，防止版本迁移后旧参数直到打包末尾才失败。
test('macOS wrapper unsigned override validates against the installed builder', async () => {
  const script = readFileSync(new URL('../../../build-macos-installer.sh', import.meta.url), 'utf8')
  const overrides = [...script.matchAll(/'-c\.(mac\.[\w.]+)=null'/g)]
  assert.equal(overrides.length, 1, 'wrapper must explicitly disable signing')
  const inputs = { target: 'darwin-arm64', formats: ['dmg', 'zip'] }
  const args = ['--mac', 'dmg', 'zip', '-c.extraMetadata.version=0.0.0', '-c.compression=normal', '--publish', 'never']
  validatePreparedBuilderArgs([...args, `-c.${overrides[0][1]}=null`], inputs)
  const signedFlag = script.match(/'(-c\.forceCodeSigning=true)'/)[1]
  validatePreparedBuilderArgs([...args, signedFlag], inputs)
  assert.throws(() => validatePreparedBuilderArgs([...args, '-c.mac.sign=arbitrary-module'], inputs), /not admitted/)
  assert.throws(() => validatePreparedBuilderArgs([...args, '-c.mac.identity=null'], inputs), /not admitted/)
  const config = require('../electron-builder.config.cjs')
  const unsigned = { ...config, mac: { ...config.mac } }
  const keys = overrides[0][1].split('.')
  let target = unsigned
  for (const key of keys.slice(0, -1)) target = target[key]
  target[keys.at(-1)] = null
  await validateConfiguration(unsigned, { isEnabled: false })
  assert.equal(unsigned.mac.sign, null, 'unsigned build must disable the custom signer too')
  await validateConfiguration({ ...config, forceCodeSigning: true }, { isEnabled: false })
  assert.equal(typeof config.mac.sign, 'function', 'signed builds retain the payload-aware signer')
})
