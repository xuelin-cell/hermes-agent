import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import type { LoginIdentity } from '../login/session'

import type { PreparedLocalContext } from './runtime-context'
import { refreshUniSearch as realRefreshUniSearch } from './unisearch'

/** 测试仅跳过资源安装，配置子进程与账号隔离执行真实路径。 */
const refreshUniSearch = (...args: Parameters<typeof realRefreshUniSearch>) => {
  const [context, identity, request, appRoot, resourcesRoot] = args

  return realRefreshUniSearch(context, identity, request, appRoot, resourcesRoot, async () => {})
}

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()

  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('fetches authenticated cloud settings and applies them through the real Python config writer; failures retain the snapshot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unisearch-'))
  roots.push(root)
  // Even a regressed launcher may only target a second temporary directory.
  vi.stubEnv('HERMES_HOME', path.join(root, 'wrong-home'))
  vi.stubEnv('HOME', root)
  const repository = path.resolve(import.meta.dirname, '../../../..')
  const python = process.env.HERMES_TEST_PYTHON ?? path.join(repository, '.venv/bin/python')
  const home = path.join(root, 'home')
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(home, 'config.yaml'), '# keep my comment\nweb:\n  extract_backend: tavily\n')
  fs.cpSync(
    path.join(repository, 'apps/desktop/assets/unisearch-plugin'),
    path.join(root, 'dist/python-plugins/unisearch'),
    { recursive: true }
  )
  const context = { home, python, installationRoot: repository, workspace: root } as PreparedLocalContext

  let identity: LoginIdentity | null = {
    uid: 'a',
    token: 'login-token',
    expiresAt: Date.now() - 60_000,
    maskedPhone: '***'
  }

  /** 合成云端响应验证授权头与配置协议，不访问真实套餐服务。 */
  const request: typeof fetch = async (url, options) => {
    expect(String(url)).toContain('key=tool_config')
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer login-token')

    return Response.json({
      code: 0,
      data: {
        version: 'v1',
        configValue: JSON.stringify({
          tools: {
            unisearch_backend: 'bocha',
            unisearch_display_name: 'Company Search'
          }
        })
      }
    })
  }

  expect(await refreshUniSearch(context, () => identity, request, root)).toBe(true)
  const file = path.join(home, 'config.yaml')
  const config = parse(fs.readFileSync(file, 'utf8'))
  expect(fs.existsSync(path.join(root, 'wrong-home/config.yaml'))).toBe(false)
  expect(config.web).toEqual({
    search_backend: 'unisearch',
    extract_backend: 'tavily'
  })
  expect(config.plugins.entries.unisearch.settings.display_name).toBe('Company Search')
  expect(fs.readFileSync(file, 'utf8')).toContain('# keep my comment')
  const before = fs.readFileSync(file, 'utf8')
  expect(
    await refreshUniSearch(
      context,
      () => identity,
      async () => Response.json({ bad: true }),
      root
    )
  ).toBe(false)
  expect(fs.readFileSync(file, 'utf8')).toBe(before)
  expect(
    await refreshUniSearch(
      context,
      () => identity,
      async () => {
        identity = null

        return Response.json({ configValue: JSON.stringify({ unisearch_backend: 'tencent' }) })
      },
      root
    )
  ).toBe(false)
  expect(fs.readFileSync(file, 'utf8')).toBe(before)
})
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

it('activates each account’s PM dependency selection when launched by a bootstrap Python (A→B→A)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unisearch-pm-'))
  roots.push(root)
  vi.stubEnv('HOME', root)
  vi.stubEnv('HERMES_HOME', path.join(root, 'wrong-home'))
  vi.stubEnv('HERMES_DISABLE_LAZY_INSTALLS', '1')
  const repository = path.resolve(import.meta.dirname, '../../../..')
  const testPython = process.env.HERMES_TEST_PYTHON ?? path.join(repository, '.venv/bin/python')
  const fixtureEnv = { PATH: process.env.PATH, HOME: root, HERMES_HOME: path.join(root, 'unused') }

  const version = execFileSync(
    testPython,
    ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'],
    { env: fixtureEnv, encoding: 'utf8' }
  ).trim()

  const dependencies = execFileSync(testPython, ['-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'], {
    env: fixtureEnv,
    encoding: 'utf8'
  }).trim()

  const bootstrapRoot = path.join(root, 'bootstrap')
  execFileSync(testPython, ['-m', 'venv', '--without-pip', bootstrapRoot], { env: fixtureEnv })
  const python = path.join(bootstrapRoot, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  expect(
    execFileSync(python, ['-c', 'import importlib.util; print(importlib.util.find_spec("ruamel"))'], {
      env: fixtureEnv,
      encoding: 'utf8'
    }).trim()
  ).toBe('None')
  fs.cpSync(
    path.join(repository, 'apps/desktop/assets/unisearch-plugin'),
    path.join(root, 'dist/python-plugins/unisearch'),
    { recursive: true }
  )
  const key = createHash('sha256').update(fs.realpathSync.native(repository)).digest('hex').slice(0, 16)

  for (const name of ['a', 'b']) {
    const home = path.join(root, name)
    const state = path.join(home, 'installs', key)
    const generation = path.join(state, 'environments', 'fixture')
    const packages = process.platform === 'win32' ? 'Lib/site-packages' : `lib/python${version}/site-packages`
    fs.mkdirSync(path.dirname(path.join(generation, packages)), { recursive: true })
    fs.writeFileSync(path.join(generation, 'pyvenv.cfg'), `version = ${version}.0\n`)
    fs.symlinkSync(dependencies, path.join(generation, packages), process.platform === 'win32' ? 'junction' : 'dir')
    fs.writeFileSync(
      path.join(state, 'facts.json'),
      JSON.stringify({ packages: { venv: { environment: generation } } })
    )
  }

  for (const name of ['a', 'b', 'a']) {
    const home = path.join(root, name)

    const identity: LoginIdentity = {
      uid: name,
      token: `fixture-${name}`,
      expiresAt: Date.now() + 60_000,
      maskedPhone: '***'
    }

    const context = { home, python, installationRoot: repository, workspace: root } as PreparedLocalContext
    await refreshUniSearch(
      context,
      () => identity,
      async () => Response.json({ configValue: JSON.stringify({ unisearch_display_name: name }) }),
      root
    )
    expect(
      parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).plugins.entries.unisearch.settings.display_name
    ).toBe(name)
  }

  expect(fs.existsSync(path.join(root, 'wrong-home/config.yaml'))).toBe(false)
}, 20_000)

it.each([
  '?api_key=fixture-secret',
  '?API%5FKEY=fixture-secret',
  '?%2561pi_key=fixture-secret',
  '?access_token=fixture-secret',
  '?password=fixture-secret',
  '?x-amz-signature=fixture-secret'
])('rejects credential-bearing service parameters before changing saved settings: %s', async query => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unisearch-url-'))
  roots.push(root)
  vi.stubEnv('HOME', root)
  const repository = path.resolve(import.meta.dirname, '../../../..')
  const home = path.join(root, 'home')
  fs.mkdirSync(home)
  const file = path.join(home, 'config.yaml')
  fs.writeFileSync(file, 'web:\n  search_backend: brave\n  extract_backend: tavily\n')
  fs.cpSync(
    path.join(repository, 'apps/desktop/assets/unisearch-plugin'),
    path.join(root, 'dist/python-plugins/unisearch'),
    { recursive: true }
  )

  const context = {
    home,
    python: process.env.HERMES_TEST_PYTHON ?? path.join(repository, '.venv/bin/python'),
    installationRoot: repository,
    workspace: root
  } as PreparedLocalContext

  const owner = { uid: 'fixture', token: 'synthetic', expiresAt: Date.now() + 60_000, maskedPhone: '***' }
  await refreshUniSearch(
    context,
    () => owner,
    async () => Response.json({ bad: true }),
    root
  )
  const before = fs.readFileSync(file, 'utf8')
  expect(
    await refreshUniSearch(
      context,
      () => owner,
      async () =>
        Response.json({ configValue: JSON.stringify({ unisearch_url: 'https://example.invalid/search' + query }) }),
      root
    )
  ).toBe(false)
  expect(fs.readFileSync(file, 'utf8')).toBe(before)
  expect(before).not.toContain('fixture-secret')
})

it('preserves ordinary service query parameters through both validators', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unisearch-url-valid-'))
  roots.push(root)
  vi.stubEnv('HOME', root)
  const repository = path.resolve(import.meta.dirname, '../../../..')
  const home = path.join(root, 'home')
  fs.mkdirSync(home)
  fs.cpSync(
    path.join(repository, 'apps/desktop/assets/unisearch-plugin'),
    path.join(root, 'dist/python-plugins/unisearch'),
    { recursive: true }
  )

  const context = {
    home,
    python: process.env.HERMES_TEST_PYTHON ?? path.join(repository, '.venv/bin/python'),
    installationRoot: repository,
    workspace: root
  } as PreparedLocalContext

  const owner = { uid: 'fixture', token: 'synthetic', expiresAt: Date.now() + 60_000, maskedPhone: '***' }
  const url = 'https://example.invalid/search?region=cn&key=page&code=reference&token='
  expect(
    await refreshUniSearch(
      context,
      () => owner,
      async () => Response.json({ configValue: JSON.stringify({ unisearch_url: url }) }),
      root
    )
  ).toBe(true)
  expect(parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).plugins.entries.unisearch.settings.url).toBe(
    url
  )
})
