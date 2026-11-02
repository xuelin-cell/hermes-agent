import { createServer } from 'node:http'
import { afterEach, expect, test } from 'vitest'
import {
  downloadWithResume, electronMirrorEnv, electronPostinstallFailed, externalLockTarballs, reachablePackageNames,
} from '../scripts/build/node-deps.mjs'

const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(done => server.close(done))))
})

test('reads a failed Electron postinstall from the npm log', () => {
  const log = [
    'error code 3',
    'error path C:\\repo\\apps\\desktop\\node_modules\\electron',
    'error command failed',
  ].join('\n')

  expect(electronPostinstallFailed(log)).toBe(true)
  expect(electronPostinstallFailed('error path C:\\repo\\node_modules\\node-pty')).toBe(false)
})

test('defaults the Electron mirror but keeps an explicit one', () => {
  expect(electronMirrorEnv({ PATH: '/bin' }).ELECTRON_MIRROR).toBe('https://npmmirror.com/mirrors/electron/')
  expect(electronMirrorEnv({ ELECTRON_MIRROR: 'https://example.test/electron/' }).ELECTRON_MIRROR)
    .toBe('https://example.test/electron/')
})

test('prefetches only lock tarballs the registry does not serve', () => {
  const packages = {
    'node_modules/xlsx': {
      resolved: 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz',
      integrity: 'sha512-cGRhdGE=',
    },
    'node_modules/electron': {
      resolved: 'https://registry.npmjs.org/electron/-/electron-40.10.2.tgz',
      integrity: 'sha512-ZWxlY3Ryb24=',
    },
    'node_modules/local': { resolved: 'file:vendor/local' },
  }

  expect(externalLockTarballs({ packages })).toEqual([
    { name: 'xlsx', url: 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz', integrity: 'sha512-cGRhdGE=' },
  ])
})

test('leaves a registry-only lock untouched', () => {
  const packages = {
    'node_modules/npm': { resolved: 'https://registry.npmmirror.com/npm/-/npm-11.6.2.tgz', integrity: 'sha512-aGk=' },
  }

  expect(externalLockTarballs({ packages })).toEqual([])
})

test('reads the dependency closure of the selected workspaces', () => {
  const lock = { packages: {
    'apps/desktop': { dependencies: { electron: '^40.0.0', xlsx: 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz' } },
    'ui-tui': { dependencies: { ink: '^5.0.0' } },
    'node_modules/electron': { dependencies: { 'node-pty': '^1.0.0' } },
    'node_modules/xlsx': {},
    'node_modules/ink': {},
    'node_modules/node-pty': {},
  } }

  const desktop = reachablePackageNames(lock, ['apps/desktop'])
  expect(desktop.has('xlsx')).toBe(true)
  expect(desktop.has('node-pty')).toBe(true)
  expect(desktop.has('ink')).toBe(false)
  expect(reachablePackageNames(lock, ['ui-tui']).has('xlsx')).toBe(false)
})

test('resumes a dropped download from the last received byte', async () => {
  const payload = Buffer.alloc(300000, 7)
  const ranges = []
  const server = createServer((request, response) => {
    const start = Number(/bytes=(\d+)-/.exec(request.headers.range ?? '')?.[1] ?? 0)
    ranges.push(start)
    if (ranges.length === 1) {
      response.writeHead(200, { 'content-length': payload.length })
      response.write(payload.subarray(0, 120000))
      setTimeout(() => response.destroy(), 20)
      return
    }
    response.writeHead(206, {
      'content-length': payload.length - start,
      'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
    })
    response.end(payload.subarray(start))
  })
  servers.push(server)
  await new Promise(done => server.listen(0, '127.0.0.1', done))

  const body = await downloadWithResume(`http://127.0.0.1:${server.address().port}/xlsx.tgz`, { stallMs: 5000 })

  expect(body.equals(payload)).toBe(true)
  expect(ranges[0]).toBe(0)
  expect(ranges.at(-1)).toBeGreaterThan(0)
}, 15000)
