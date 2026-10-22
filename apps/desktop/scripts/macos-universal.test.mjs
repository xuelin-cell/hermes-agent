import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as asar from '@electron/asar'
import plist from 'plist'
import { test } from 'vitest'
import { assembleUniversal, inspectInput, signUniversalApp, createUniversalDmg } from './macos-universal.mjs'

// 真正编译两种 Mach-O 并执行上游合并，验证资源选择所依赖的制品结构。
test.runIf(process.platform === 'darwin')('merges native slices and retains architecture-specific payloads and ESM archives', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-native-'))
  try {
    const source = path.join(root, 'main.c')
    fs.writeFileSync(source, 'int main(void) { return 0; }\n')
    const inputs = {}
    for (const arch of ['x64', 'arm64']) {
      const app = path.join(root, `${arch}.app`)
      inputs[arch] = app
      const resources = path.join(app, 'Contents', 'Resources')
      const executable = path.join(app, 'Contents', 'MacOS', 'UniWork')
      fs.mkdirSync(path.dirname(executable), { recursive: true })
      execFileSync('xcrun', ['clang', '-arch', arch === 'x64' ? 'x86_64' : arch, source, '-o', executable])
      const payload = path.join(resources, 'agent-payload')
      for (const name of ['repo', 'tools/python/bin', 'site', 'bin']) fs.mkdirSync(path.join(payload, name), { recursive: true })
      fs.copyFileSync(executable, path.join(payload, 'tools/python/bin/python'))
      fs.writeFileSync(path.join(payload, 'bin', 'hermes'), arch)
      fs.writeFileSync(path.join(payload, 'manifest.json'), '{}')
      fs.writeFileSync(path.join(payload, 'tools/facts.json'), JSON.stringify({ schema: 1, packages: { python: { entry: 'python', version: 'test', target: `darwin-${arch}`, artifacts: ['a'.repeat(64)], digest: 'before-signing' } } }))
      fs.mkdirSync(path.join(resources, 'open-connector', 'node_modules'), { recursive: true })
      fs.writeFileSync(path.join(resources, 'install-stamp.json'), JSON.stringify({
        commit: 'a'.repeat(40), dirty: false, payload: 'bundled', desktopRuntimeLayout: 1, updateMechanism: 'external',
        runtime: { repoDir: 'repo', toolsDir: 'tools', storePython: 'tools/python/bin/python', sitePackages: 'site', commands: { hermes: 'bin/hermes' } }
      }))
      fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist.build({
        CFBundlePackageType: 'APPL', CFBundleIdentifier: 'com.uniwork.fixture', CFBundleExecutable: 'UniWork', CFBundleShortVersionString: '1.0.0'
      }))
      const code = path.join(root, `code-${arch}`)
      fs.mkdirSync(code)
      fs.writeFileSync(path.join(code, 'package.json'), JSON.stringify({ name: 'UniWork', version: '1.0.0', type: 'module', main: 'index.mjs' }))
      fs.writeFileSync(path.join(code, 'index.mjs'), `import { app } from 'electron'
import fs from 'node:fs'
app.setPath('userData', process.env.UNIVERSAL_TEST_HOME)
app.whenReady().then(() => {
fs.writeFileSync(process.env.UNIVERSAL_TEST_RESULT, JSON.stringify({ selected: '${arch}', layout: process.uniworkUniversalLayout }))
app.exit(0)
})
`)
      await asar.createPackage(code, path.join(resources, 'app.asar'))
      fs.mkdirSync(path.join(resources, 'app.asar.unpacked'))
      fs.writeFileSync(path.join(resources, 'app.asar.unpacked', 'native-marker'), arch)
    }
    const out = path.join(root, 'UniWork.app')
    await assembleUniversal({ ...inputs, out, work: path.join(root, 'work') })
    const arches = execFileSync('/usr/bin/lipo', ['-archs', path.join(out, 'Contents/MacOS/UniWork')], { encoding: 'utf8' })
    assert.ok(arches.includes('x86_64') && arches.includes('arm64'))
    const resources = path.join(out, 'Contents/Resources')
    for (const arch of ['arm64', 'x64']) {
      assert.equal(fs.readFileSync(path.join(resources, 'agent-payload', `darwin-${arch}`, 'bin/hermes'), 'utf8'), arch)
      assert.equal(fs.readFileSync(path.join(resources, `app-${arch}.asar.unpacked/native-marker`), 'utf8'), arch)
    }
    assert.equal(JSON.parse(asar.extractFile(path.join(resources, 'app.asar'), 'package.json')).type, 'module')
    assert.throws(() => inspectInput(inputs.arm64, 'x64'), /Expected native x64/)
    await signUniversalApp(out)
    for (const arch of ['x64', 'arm64']) {
      const facts = JSON.parse(fs.readFileSync(path.join(resources, 'agent-payload', `darwin-${arch}`, 'tools/facts.json'), 'utf8'))
      assert.match(facts.packages.python.digest, /^[a-f0-9]{64}$/)
    }
    const result = path.join(root, 'launch-result.json')
    const home = path.join(root, 'user-data')
    fs.mkdirSync(home)
    const env = { ...process.env, UNIVERSAL_TEST_RESULT: result, UNIVERSAL_TEST_HOME: home }
    delete env.ELECTRON_RUN_AS_NODE
    execFileSync(createRequire(import.meta.url)('electron'), [path.join(resources, 'app.asar'), `--user-data-dir=${home}`], { env, timeout: 20000 })
    assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), { selected: process.arch, layout: { commit: 'a'.repeat(40), arch: process.arch } })
    const dmg = createUniversalDmg(out, root, '1.0.0')
    assert.ok(fs.statSync(dmg).size > 0)
    // 输入目录仍可再次使用，组装不能移动或改写其载荷。
    assert.ok(fs.existsSync(path.join(inputs.x64, 'Contents/Resources/agent-payload/tools/python/bin/python')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}, 60000)
