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
  expect(modules[1].workspace).toBe('work')
  expect(JSON.parse(localStorage.getItem('uniwork.welcome.modules.v3.zh-CN')!)).toEqual(first)
  await loadWelcomeCatalog('zh-CN', true)
  expect($welcomeCatalog.get()['zh-CN'].modules).toBe(modules)

  const latest = {
    ...first,
    modules: [
      {
        name: '日常办公',
        tags: [{ id: 'slides', name: '幻灯片', templates: [{ id: 'ppt', name: 'PPT', prompt: '接口最新提示词' }] }]
      }
    ]
  }

  request.mockResolvedValue(latest)
  await loadWelcomeCatalog('zh-CN', true)
  const refreshed = $welcomeCatalog.get()['zh-CN'].modules!
  expect(refreshed[0].tags[0].templates[0].prompt).toBe('接口最新提示词')
  expect(JSON.parse(localStorage.getItem('uniwork.welcome.modules.v3.zh-CN')!)).toEqual(latest)
  request.mockResolvedValue({ modules: [] })
  await loadWelcomeCatalog('zh-CN', true)
  expect($welcomeCatalog.get()['zh-CN'].modules).toBe(refreshed)
  expect($welcomeCatalog.get()['zh-CN'].status).toBe('cached')
  vi.resetModules()
  const restored = await import('./catalog-store')
  expect(restored.$welcomeCatalog.get()['zh-CN'].modules).toEqual(refreshed)
})

it('starts without hardcoded modules, retries cloud failures and restores only cloud locale data', async () => {
  localStorage.setItem('uniwork.welcome.modules.v3.zh-CN', 'broken cache')
  const { $welcomeCatalog, $resolvedWelcomeCatalog, loadWelcomeCatalog } = await import('./catalog-store')
  expect($resolvedWelcomeCatalog['zh-CN'].get().modules).toEqual([])
  expect($resolvedWelcomeCatalog.en.get().modules).toEqual([])
  const request = vi.fn().mockRejectedValue(new Error('offline'))
  vi.stubGlobal('hermesDesktop', { getWelcomeCatalog: request })
  await loadWelcomeCatalog('zh-CN', true)
  expect($resolvedWelcomeCatalog['zh-CN'].get().modules).toEqual([])
  request.mockResolvedValue({ modules: [{ name: 'Cloud module' }] })
  await loadWelcomeCatalog('en', true)
  const english = $welcomeCatalog.get().en
  $welcomeCatalog.set({ en: english, 'zh-CN': { status: 'cached', modules: null } })
  expect($resolvedWelcomeCatalog['zh-CN'].get().modules).toBe(english.modules)
  $welcomeCatalog.set({ en: english, 'zh-CN': { status: 'ready', modules: [] } })
  expect($resolvedWelcomeCatalog['zh-CN'].get().modules).toEqual([])
})
