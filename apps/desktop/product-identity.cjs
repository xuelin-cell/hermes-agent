// The desktop product identity — THE single source for every name-shaped
// value a variant owns. HERMES_DESKTOP_VARIANT=light builds "UniWork
// Light", the remote-only client; everything else is full "UniWork".
//
// Consumed at build time by electron-builder.config.cjs (packaging
// identity). electron/product-identity.ts is the typed runtime accessor.
// @ts-check
/// <reference types="node" />
'use strict'

const variants = {
  '': { display: 'UniWork', kebab: 'hermes', pascal: 'UniWork' },
  light: {
    display: 'UniWork Light',
    kebab: 'hermes-light',
    pascal: 'UniWorkLight'
  },
  bundled: {
    display: 'UniWork',
    kebab: 'hermes-bundled',
    pascal: 'UniWorkBundled'
  }
}

const variant = process.env.HERMES_DESKTOP_VARIANT || ''
if (!['', 'light', 'bundled', 'store'].includes(variant)) {
  throw new Error(`Unknown HERMES_DESKTOP_VARIANT ${variant}. expected one of (empty), light, bundled, store`)
}

// 'store' is a Store-submission packaging identity layered on the bundled
// variant: same Electron app (displayName/appId/appNamePascal -> shared
// userData + single-instance lock with the out-of-store install), different
// MSIX package identity. The Store re-signs on submission.
const store = variant === 'store'
const light = variant === 'light'
const name = variants[store ? 'bundled' : (variant || '')]

// The electron-updater feed channel this build PUBLISHES to. A canary
// tag (vX.Y.Z+canary.YYYYMMDDTHHMMSSZ) writes canary.yml / light-canary.yml;
// stable tags write latest.yml / light.yml. Keyed on the payload tag so
// the one release workflow serves both channels — a canary build can
// never overwrite the stable feed file, and vice versa.
const canary = /\+canary\.20\d{6}T\d{6}Z$/.test(process.env.HERMES_PAYLOAD_TAG || '')

// desktop-mt: 我们的 Windows 安装包（bundled）用固定身份：名字、appId、exe 和安装目录都不带提交号，
// 装新包就覆盖旧包。上游提交版带提交号是为了并存，可 MT 登录壳把数据目录和单实例锁统一成了 uniworker，
// 并存的两版只会互抢。打包入口（scripts/bundles/desktop_inputs.py）默认设 UNIWORK_FIXED_IDENTITY=1；
// 提交号照样记进构建信息，更新源也照样按提交版处理（不配）。
const fixedIdentity = variant === 'bundled' && process.env.UNIWORK_FIXED_IDENTITY === '1'
// 不用老 UniWork 的 com.uniwork.app：NSIS 按 appId 认旧版，会把老 UniWork 当成本应用的旧版本去卸载。
const UNIWORK_APP_ID = 'com.uniwork.desktop'

// Nonstable installs own their package family and local desktop state. The
// seven-character commit suffix also names the CLI and fits MSIX's name cap.
const buildCommitEnv = process.env.HERMES_BUILD_COMMIT || ''
const buildCommit = /^[a-f0-9]{40}$/.test(buildCommitEnv) ? buildCommitEnv.slice(0, 7) : null
const nameCommit = fixedIdentity ? null : buildCommit
const nameCanary = !fixedIdentity && canary
const displayName = nameCommit
  ? `${name.display} ${nameCommit}`
  : nameCanary
    ? `${name.display} Canary`
    : name.display

const kebabSuffix = nameCommit ? `-${nameCommit}` : nameCanary ? '-canary' : ''
const pascalSuffix = nameCommit ? `Commit${nameCommit}` : nameCanary ? 'Canary' : ''
const cliName = `${light ? 'hermes-light' : 'hermes'}${kebabSuffix}`
if (store && (canary || buildCommit)) {
  throw new Error('Store packaging is only eligible for stable releases')
}

/** @typedef {import("./product-identity.d.cts")} ProductIdentity */

/** @type {ProductIdentity} */
const identity = {
  store,
  light,
  displayName,
  appId: fixedIdentity ? UNIWORK_APP_ID : `com.nousresearch.${name.kebab}${kebabSuffix}`,
  // Store and commit builds do not publish a release feed.
  channel: store || buildCommit ? null : light ? (canary ? 'light-canary' : 'light') : (canary ? 'canary' : 'latest'),
  appNamePascal: `${name.pascal}${pascalSuffix}`,
  artifactNamePascal: name.pascal,
  windowsExecutableName: kebabSuffix ? cliName : displayName,
  cliName,
  msixAppIdWithOrg: `NousResearch.${name.pascal}${pascalSuffix}`,
  ...(store
    ? {
        storeMsix: {
          // Partner Center publisher identity (the account's publisher ID) —
          // validated + re-signed by the Store on submission.
          identityName: 'NousResearchInc.HermesAgent',
          publisher: 'CN=EE6D86E4-606F-4E38-B940-AD7248C9D519',
          publisherDisplayName: 'Nous Research Inc.'
        }
      }
    : {})
}

const { channelBuildRequest } = require('../../scripts/msix-shared.mjs')
const request = channelBuildRequest()
module.exports = request
  ? Object.freeze({ ...request.identity, store: false, light: false, channel: request.channel })
  : identity
