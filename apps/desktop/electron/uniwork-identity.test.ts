// desktop-mt: 我们的 Windows 安装包（bundled 提交版）用固定身份，装新包覆盖旧包，而不是在旁边再多一个
// 「UniWork <提交号>」。所有版本共用数据目录和单实例锁（login/bootstrap.ts），上游按提交并存那一套对我们不适用。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import type { AppInfo as BuilderAppInfo, Configuration, Packager } from 'app-builder-lib'
import { afterEach, test } from 'vitest'

import type { ProductIdentity } from './product-identity'

const require: NodeJS.Require = createRequire(import.meta.url)
const SELECTORS = ['HERMES_DESKTOP_VARIANT', 'HERMES_PAYLOAD_TAG', 'HERMES_BUILD_COMMIT', 'UNIWORK_FIXED_IDENTITY'] as const
const COMMIT_A = 'abcdef1234567890abcdef1234567890abcdef12'
const COMMIT_B = '1234567890abcdef1234567890abcdef12345678'

type Selectors = Partial<Record<(typeof SELECTORS)[number], string>>

function fresh<T>(file: string, selectors: Selectors): T {
  for (const name of SELECTORS) {
    delete process.env[name]
  }

  Object.assign(process.env, selectors)

  for (const module of ['../product-identity.cjs', '../electron-builder.config.cjs']) {
    delete require.cache[require.resolve(module)]
  }

  return require(file) as T
}

const identity = (selectors: Selectors): ProductIdentity => fresh('../product-identity.cjs', selectors)

afterEach((): void => {
  for (const name of SELECTORS) {
    delete process.env[name]
  }
})

test('a fixed-identity commit build keeps one name, appId and executable across commits', (): void => {
  const a: ProductIdentity = identity({ HERMES_DESKTOP_VARIANT: 'bundled', HERMES_BUILD_COMMIT: COMMIT_A, UNIWORK_FIXED_IDENTITY: '1' })
  const b: ProductIdentity = identity({ HERMES_DESKTOP_VARIANT: 'bundled', HERMES_BUILD_COMMIT: COMMIT_B, UNIWORK_FIXED_IDENTITY: '1' })

  assert.deepEqual(a, b)
  assert.equal(a.displayName, 'UniWork')
  // 不是老 UniWork 的 com.uniwork.app：NSIS 会把那个应用当成本应用的旧版本。
  assert.equal(a.appId, 'com.uniwork.desktop')
  assert.equal(a.windowsExecutableName, 'UniWork')
  assert.equal(a.appNamePascal, a.artifactNamePascal)
  assert.equal(a.cliName, 'hermes')
  // 仍是提交版：不配更新源。
  assert.equal(a.channel, null)
})

test('the fixed identity reaches the NSIS packaging inputs', (): void => {
  const pkg: { name: string; productName: string; version: string } = require('../package.json')
  const selectors: Selectors = { HERMES_DESKTOP_VARIANT: 'bundled', HERMES_BUILD_COMMIT: COMMIT_A, UNIWORK_FIXED_IDENTITY: '1' }
  const config: Configuration & { extraMetadata: Record<string, unknown> } = fresh('../electron-builder.config.cjs', selectors)

  assert.equal(config.appId, 'com.uniwork.desktop')
  assert.equal(config.productName, 'UniWork')
  assert.equal(config.win?.executableName, 'UniWork')
  assert.equal(config.extraMetadata.productName, undefined)
  assert.equal(config.publish, null)

  const { AppInfo }: { AppInfo: typeof BuilderAppInfo } = require('../../../node_modules/app-builder-lib/dist/appInfo.js')
  const appInfo: BuilderAppInfo = new AppInfo({ config, metadata: { ...pkg, ...config.extraMetadata } } as Packager, null, config.win)

  // NSIS 的注册表 GUID 由 appId 算出，安装目录名取产品文件名。
  assert.equal(appInfo.id, 'com.uniwork.desktop')
  assert.equal(appInfo.productFilename, 'UniWork')
})

test('without the switch, and for other variants, commit builds keep the upstream per-commit identity', (): void => {
  const upstream: ProductIdentity = identity({ HERMES_DESKTOP_VARIANT: 'bundled', HERMES_BUILD_COMMIT: COMMIT_A })
  assert.equal(upstream.displayName, 'UniWork abcdef1')
  assert.equal(upstream.appId, 'com.nousresearch.hermes-bundled-abcdef1')

  const light: ProductIdentity = identity({ HERMES_DESKTOP_VARIANT: 'light', HERMES_BUILD_COMMIT: COMMIT_A, UNIWORK_FIXED_IDENTITY: '1' })
  assert.equal(light.displayName, 'UniWork Light abcdef1')
  assert.equal(light.appId, 'com.nousresearch.hermes-light-abcdef1')
})
