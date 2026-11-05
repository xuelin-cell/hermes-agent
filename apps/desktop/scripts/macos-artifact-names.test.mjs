import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'

const require = createRequire(import.meta.url)
const libraryRoot = path.dirname(path.dirname(require.resolve('app-builder-lib')))
const { AppInfo } = await import(pathToFileURL(path.join(libraryRoot, 'dist/appInfo.js')))
const { MacPackager } = await import(pathToFileURL(path.join(libraryRoot, 'dist/macPackager.js')))
const { Arch } = await import('builder-util')

test('macOS DMG and ZIP names have distinct format suffixes while the global signing stem expands without a format', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'macos-artifact-names-'))
  const previousHome = process.env.HERMES_HOME
  process.env.HERMES_HOME = home
  try {
    const metadata = require('../package.json')
    for (const config of [require('../electron-builder.config.cjs'), require('../electron-builder.adhoc.cjs')]) {
      const info = { config, metadata, projectDir: home, buildResourcesDir: home, options: {} }
      info.appInfo = new AppInfo(info)
      const packager = new MacPackager(info)
      for (const arch of [Arch.arm64, Arch.x64]) {
        const stem = packager.expandMacro(config.artifactName, Arch[arch])
        const names = ['dmg', 'zip'].map(format => {
          const name = packager.expandArtifactNamePattern(config[format], format, arch)
          assert.equal(path.extname(name), `.${format}`)
          assert.equal(name, `${stem}.${format}`)
          return name
        })
        assert.notEqual(names[0], names[1])
      }
    }
  } finally {
    if (previousHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})
