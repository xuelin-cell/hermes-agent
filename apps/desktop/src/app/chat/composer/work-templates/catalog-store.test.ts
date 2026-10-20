import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  vi.unstubAllGlobals()
})

it('keeps source-position selection keys and raw versioned data, retaining a good catalog after invalid refreshes', async () => {
  const { $welcomeCatalog, loadWelcomeCatalog } = await import('./catalog-store')

  const first = {
    version: 'v-first',
    modules: [
      { name: '学习生活', sort: 30, enabled: false },
      { name: '代码开发', sort: 20, workspace: 'work' },
      { name: '日常办公', sort: 10 }
    ]
  }

  const request = vi.fn().mockResolvedValue(first)
  vi.stubGlobal('hermesDesktop', { getWelcomeCatalog: request })
  await loadWelcomeCatalog('zh-CN', true)
  const modules = $welcomeCatalog.get()['zh-CN'].modules!
  expect(modules.map(module => module.id)).toEqual([
    'configured-module-2',
    'configured-module-1',
    'configured-module-0'
  ])
  expect(modules[1].workspace).toBe('codex')
  const stored = localStorage.getItem('uniwork.welcome.modules.v3.zh-CN')
  expect(JSON.parse(stored!)).toEqual(first)
  request.mockResolvedValue({ ...first, modules: [{ name: 'Must not replace a matching version' }] })
  await loadWelcomeCatalog('zh-CN', true)
  expect($welcomeCatalog.get()['zh-CN'].modules).toBe(modules)
  expect(localStorage.getItem('uniwork.welcome.modules.v3.zh-CN')).toBe(stored)
  request.mockResolvedValue({ modules: [] })
  await loadWelcomeCatalog('zh-CN', true)
  expect($welcomeCatalog.get()['zh-CN'].modules).toBe(modules)
  expect($welcomeCatalog.get()['zh-CN'].status).toBe('cached')
})

it('falls back only for absent locale modules, keeping an explicit empty locale empty', async () => {
  const { $welcomeCatalog, $resolvedWelcomeCatalog } = await import('./catalog-store')
  const english = $welcomeCatalog.get().en
  $welcomeCatalog.set({ en: english, 'zh-CN': { status: 'cached', modules: null } })
  expect($resolvedWelcomeCatalog['zh-CN'].get().modules).toBe(english.modules)
  $welcomeCatalog.set({ en: english, 'zh-CN': { status: 'ready', modules: [] } })
  expect($resolvedWelcomeCatalog['zh-CN'].get().modules).toEqual([])
})
