import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'
import { pinnedElectronChecksums } from './prepare-packaging-tools.mjs'

const require = createRequire(import.meta.url)
const supplier = await import(pathToFileURL(path.join(path.dirname(require.resolve('app-builder-lib')), 'util/electronGet.js')).href)

/** 创建独立的锁定 npm 包和校验清单，测试不依赖开发机缓存。 */
function fixture() {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-cache-'))
  const root = path.join(source, 'node_modules/electron')
  const version = '40.10.2'
  const target = `${process.platform}-${process.arch}`
  const filename = `electron-v${version}-${target}.zip`
  const bytes = Buffer.from('artifact whose SHA256 is pinned by the npm package')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(path.join(source, 'apps/desktop'), { recursive: true })
  fs.writeFileSync(path.join(source, 'apps/desktop/package.json'), '{}')
  fs.writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/electron': { version } } }))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'electron', version, main: 'index.js' }))
  fs.writeFileSync(path.join(root, 'index.js'), '')
  fs.writeFileSync(path.join(root, 'checksums.json'), JSON.stringify({ [filename]: createHash('sha256').update(bytes).digest('hex') }))
  return { source, root, version, target, bytes }
}

// 走真实下载器：首次只取归档，断网后复用，篡改缓存后拒绝离线返回。
test('verified Electron archives are reused offline and corrupt cache is rejected', async () => {
  const f = fixture()
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push(request.url)
    response.end(f.bytes)
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/electron.zip`
    const options = {
      version: f.version, platformName: process.platform, arch: process.arch, artifactName: 'electron',
      cacheDir: path.join(f.source, 'cache'),
      options: { checksums: pinnedElectronChecksums(f.source, f.version, f.target),
        mirrorOptions: { resolveAssetURL: async () => url }, downloadOptions: { signal: AbortSignal.timeout(5000) } },
    }
    const archive = await supplier.downloadElectronArtifactZip(options)
    assert.deepEqual(requests, ['/electron.zip'])
    await new Promise(resolve => server.close(resolve))
    assert.equal(await supplier.downloadElectronArtifactZip(options), archive)
    fs.writeFileSync(archive, 'corrupt')
    await assert.rejects(supplier.downloadElectronArtifactZip(options))
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    fs.rmSync(f.source, { recursive: true, force: true })
  }
}, 15000)

// 缺失或版本不符的本地清单必须失败，不能退化为无校验缓存。
test('Electron checksums require the exact pinned version and target', () => {
  const f = fixture()
  try {
    assert.throws(() => pinnedElectronChecksums(f.source, '40.10.3', f.target), /differs/)
    fs.writeFileSync(path.join(f.root, 'checksums.json'), '{}')
    assert.throws(() => pinnedElectronChecksums(f.source, f.version, f.target), /Missing official/)
  } finally {
    fs.rmSync(f.source, { recursive: true, force: true })
  }
})
