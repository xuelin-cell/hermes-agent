import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ userData: '', open: vi.fn(), request: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => mock.userData, getAppPath: () => mock.userData, isPackaged: false },
  net: { fetch: (...args: unknown[]) => mock.request(...args) }
}))
vi.mock('./dev-extras', () => ({ ensureDevExtras: vi.fn(async () => {}) }))
vi.mock('./desktop-python-plugins', () => ({
  desktopPythonPluginsRoot: (root: string) => root + '/dist/python-plugins',
  retireAccountUniAgentGatePlugin: () => {}
}))
vi.mock('../main', () => ({ openAccountDesktop: mock.open }))

import { startAccountDesktop } from './desktop-runtime'
import { ensureDevExtras } from './dev-extras'
import type { PreparedLocalContext } from './runtime-context'
import { refreshUniSearch } from './unisearch'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()

  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** 每例使用有效解释器与独立账号，故障只注入搜索组件。 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unisearch-startup-'))
  roots.push(root)
  mock.userData = root
  const repository = path.resolve(import.meta.dirname, '../../../..')
  const home = path.join(root, 'home')
  fs.mkdirSync(home)
  const before = 'web:\n  search_backend: brave\n  extract_backend: tavily\n'
  fs.writeFileSync(path.join(home, 'config.yaml'), before)
  const plugin = path.join(root, 'dist/python-plugins/unisearch')
  fs.mkdirSync(plugin, { recursive: true })

  const context = {
    id: 'fixture',
    home,
    workspace: root,
    installationRoot: repository,
    python: process.env.HERMES_TEST_PYTHON ?? path.join(repository, '.venv/bin/python')
  } as PreparedLocalContext

  const owner = { uid: 'fixture', token: 'synthetic', expiresAt: Date.now() + 60_000, maskedPhone: '***' }
  vi.stubEnv('HOME', root)
  vi.stubEnv('HERMES_HOME', path.join(root, 'wrong-home'))

  return { root, home, before, plugin, context, owner, repository }
}

it('搜索配置脚本单独失败时仍打开桌面并保留Brave／Tavily设置', async () => {
  const f = fixture()
  fs.writeFileSync(path.join(f.plugin, 'configure.py'), 'import sys\nsys.exit(23)\n')
  mock.request.mockResolvedValue(Response.json({ configValue: JSON.stringify({ unisearch_backend: 'tencent' }) }))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await startAccountDesktop(f.context, () => f.owner)
  await refreshUniSearch(f.context, () => f.owner, mock.request, f.root)
  expect(mock.open).toHaveBeenCalledTimes(1)
  expect(fs.readFileSync(path.join(f.home, 'config.yaml'), 'utf8')).toBe(f.before)
  expect(warn).toHaveBeenCalled()
  expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic')
})

it('网络刷新等待时桌面已打开，且本地首次配置先完成插件注册准备', async () => {
  const f = fixture()
  fs.cpSync(path.join(f.repository, 'apps/desktop/assets/unisearch-plugin'), f.plugin, { recursive: true })
  let release!: (value: Response) => void
  mock.request.mockImplementation(
    () =>
      new Promise<Response>(resolve => {
        release = resolve
      })
  )

  try {
    await startAccountDesktop(f.context, () => f.owner)
    expect(mock.open).toHaveBeenCalledTimes(1)
    const config = fs.readFileSync(path.join(f.home, 'config.yaml'), 'utf8')
    expect(config).toContain('unisearch')
    expect(config).toContain('brave')
    expect(config).toContain('tavily')
  } finally {
    release(Response.json({ configValue: JSON.stringify({ unisearch_backend: 'bocha' }) }))
    await refreshUniSearch(f.context, () => f.owner, mock.request, f.root)
  }
})

it('基础运行组件失败仍中断启动，搜索降级不会掩盖账号运行时错误', async () => {
  const f = fixture()
  vi.mocked(ensureDevExtras).mockRejectedValueOnce(new Error('core runtime failed'))
  await expect(startAccountDesktop(f.context, () => f.owner)).rejects.toThrow('core runtime failed')
  expect(mock.open).not.toHaveBeenCalled()
  expect(mock.request).not.toHaveBeenCalled()
})
