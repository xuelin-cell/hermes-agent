import { afterEach, expect, it, vi } from 'vitest'

import { storeBrowserLogin } from '../../../../../../shared/src/browser-maas-auth.js'

const login = (id: string) => storeBrowserLogin(import.meta.env.BASE_URL || '/', { maas_auth: {
  token: 'secret-' + id, loginId: id, expiresAt: Date.now() + 60_000
} })

afterEach(() => { delete window.document.documentElement.dataset.hermesBrowser; localStorage.clear(); vi.unstubAllGlobals(); vi.resetModules() })

it('云端目录缓存隔离登录和语言，不认领桌面旧缓存，失败保留本账号目录', async () => {
  window.document.documentElement.dataset.hermesBrowser = 'production'
  login('alice')
  localStorage.setItem('uniwork.welcome.modules.v3.zh-CN', JSON.stringify({ modules: [{ name: 'old desktop' }] }))
  const { $welcomeCatalog, loadWelcomeCatalog } = await import('./catalog-store')
  expect($welcomeCatalog.get()['zh-CN'].modules).toBeNull()
  const request = vi.fn(async (locale: string) => ({ modules: [{ name: 'Alice ' + locale }], version: 'v3' }))
  vi.stubGlobal('hermesDesktop', { getWelcomeCatalog: request })
  await loadWelcomeCatalog('zh-CN', true)
  await loadWelcomeCatalog('en', true)
  expect($welcomeCatalog.get()['zh-CN'].modules![0].name).toBe('Alice zh-CN')
  request.mockRejectedValueOnce(new Error('unavailable'))
  await loadWelcomeCatalog('zh-CN', true)
  expect($welcomeCatalog.get()['zh-CN'].modules![0].name).toBe('Alice zh-CN')
  login('bob')
  request.mockResolvedValueOnce({ modules: [{ name: 'Bob' }], version: 'v3' })
  await loadWelcomeCatalog('zh-CN', true)
  expect($welcomeCatalog.get()['zh-CN'].modules![0].name).toBe('Bob')
  expect($welcomeCatalog.get().en.modules).toBeNull()
  login('alice')
  request.mockRejectedValueOnce(new Error('offline'))
  await loadWelcomeCatalog('zh-CN', true)
  expect($welcomeCatalog.get()['zh-CN'].modules![0].name).toBe('Alice zh-CN')
  expect([...Array(localStorage.length)].map((_, i) => localStorage.key(i)).filter(key => key?.startsWith('uniwork.welcome')).join()).not.toContain('secret-')
})

it('账号切换时丢弃旧目录响应，旧请求结束不能清掉新账号的在途请求', async () => {
  window.document.documentElement.dataset.hermesBrowser = 'production'
  login('alice')
  const { $welcomeCatalog, loadWelcomeCatalog } = await import('./catalog-store')
  let finish!: (value: { modules: { name: string }[] }) => void
  const request = vi.fn(() => new Promise<{ modules: { name: string }[] }>(done => { finish = done }))
  vi.stubGlobal('hermesDesktop', { getWelcomeCatalog: request })
  const old = loadWelcomeCatalog('zh-CN', true)
  await Promise.resolve()
  const finishOld = finish
  login('bob')
  const current = loadWelcomeCatalog('zh-CN', true)
  await Promise.resolve()
  const finishCurrent = finish
  finishOld({ modules: [{ name: 'old Alice' }] })
  await old
  expect($welcomeCatalog.get()['zh-CN'].modules).toBeNull()
  expect(loadWelcomeCatalog('zh-CN', true)).toBe(current)
  finishCurrent({ modules: [{ name: 'current Bob' }] })
  await current
  expect($welcomeCatalog.get()['zh-CN'].modules![0].name).toBe('current Bob')
})
