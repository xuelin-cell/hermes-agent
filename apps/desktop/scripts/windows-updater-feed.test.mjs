// The NSIS package is the one Windows artifact that owns its own update loop,
// so "which format did we build" and "where does it update from" are one
// contract: the switch that names electron-updater as the owner must be the
// only thing that bakes a feed, and the feed directory must be the one the
// client reads. See desktop.py for the env derivation.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { afterEach, test } from 'vitest'

const require = createRequire(import.meta.url)
const SELECTORS = [
  'HERMES_DESKTOP_VARIANT',
  'HERMES_PAYLOAD_TAG',
  'HERMES_BUILD_COMMIT',
  'UNIWORK_FIXED_IDENTITY',
  'HERMES_WINDOWS_UPDATE',
  'HERMES_WINDOWS_FORMAT',
  'CLOUDFLARE_R2_PUBLIC_URL',
  '_HERMES_CHANNEL_REQUEST_JSON'
]
const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12'
const OSS = 'https://obs-nmhhht6.cucloud.cn/model-extend-public/installer/unihermes'

function fresh(selectors) {
  for (const name of SELECTORS) delete process.env[name]
  Object.assign(process.env, selectors)
  for (const module of ['../product-identity.cjs', '../electron-builder.config.cjs']) {
    delete require.cache[require.resolve(module)]
  }

  return require('../electron-builder.config.cjs')
}

afterEach(() => {
  for (const name of SELECTORS) delete process.env[name]
})

test('the self-managed NSIS build bakes its feed at the OSS origin', () => {
  const managed = {
    HERMES_DESKTOP_VARIANT: 'bundled',
    HERMES_BUILD_COMMIT: COMMIT,
    HERMES_WINDOWS_UPDATE: 'electron-updater',
    HERMES_WINDOWS_FORMAT: 'nsis'
  }
  const config = fresh(managed)

  // A commit build, but the package is the updater's, not a one-off artifact.
  assert.deepEqual(config.win.target, ['nsis'])
  assert.deepEqual(config.win.publish, [
    { provider: 'generic', url: `${OSS}/releases/win32/stable/`, channel: 'stable' }
  ])

  // A fork or a mirror still wins over the default origin.
  const mirror = fresh({ ...managed, CLOUDFLARE_R2_PUBLIC_URL: 'https://mirror.example.com/hermes' })
  assert.equal(mirror.win.publish[0].url, 'https://mirror.example.com/hermes/releases/win32/stable/')
})

test('the per-machine NSIS build asks electron-updater to elevate', () => {
  // NsisTarget only writes `isAdminRightsRequired` into the channel yml for
  // `perMachine && (oneClick || packElevateHelper)`. This is an assisted
  // (oneClick: false) per-machine install, so without the explicit opt-in the
  // updater spawns the admin-manifested installer from a non-elevated app:
  // CreateProcess fails with ERROR_ELEVATION_REQUIRED, no files are written,
  // and the app relaunches on the old version.
  const config = fresh({
    HERMES_DESKTOP_VARIANT: 'bundled',
    HERMES_BUILD_COMMIT: COMMIT,
    HERMES_WINDOWS_UPDATE: 'electron-updater',
    HERMES_WINDOWS_FORMAT: 'nsis'
  })

  assert.equal(config.nsis.perMachine, true)
  assert.equal(config.nsis.oneClick, false)
  assert.equal(config.nsis.packElevateHelper, true)
})

test('without the switch Windows packages carry no electron-updater feed', () => {
  const oneoff = fresh({ HERMES_DESKTOP_VARIANT: 'bundled', HERMES_BUILD_COMMIT: COMMIT, HERMES_WINDOWS_FORMAT: 'nsis' })
  assert.deepEqual(oneoff.win.target, ['nsis'])
  assert.equal(oneoff.win.publish, undefined)
  assert.equal(oneoff.publish, null)

  const msix = fresh({ HERMES_DESKTOP_VARIANT: 'bundled', HERMES_PAYLOAD_TAG: 'v1.2.3', HERMES_WINDOWS_FORMAT: 'msix' })
  assert.deepEqual(msix.win.target, ['msix'])
  assert.equal(msix.win.publish, undefined)
})

test('the win32 feed dir yields the yml name electron-builder writes', () => {
  const { win32Feed } = require('../update-feed.cjs')

  assert.deepEqual(win32Feed('stable'), {
    directory: 'releases/win32/stable',
    channel: 'stable',
    fileName: 'stable.yml',
    allowPrerelease: false
  })
  // Windows update info is `<channel>.yml` (no -win32 suffix); the channel,
  // not the platform, separates the trees.
  assert.equal(win32Feed('canary').fileName, 'canary.yml')
  assert.equal(win32Feed('canary').directory, 'releases/win32/canary')
  assert.equal(win32Feed('light', true).directory, 'releases/win32/light/light')
  assert.equal(win32Feed('light-canary', true).allowPrerelease, true)
  assert.throws(() => win32Feed('../escape'), TypeError)
})
