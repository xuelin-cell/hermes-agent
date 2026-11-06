import { afterEach, beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

// Each test loads a fresh module: the record of the last failure is module state.
const load = () => import('./browser-backend-error')

it('实例还没准备好（网关先超时 504、实例重建中 502/503、连不上）时，启动失败要重试', async () => {
  for (const status of [504, 502, 503, 408]) {
    const { browserBackendError, backendFailedTransiently } = await load()
    expect(backendFailedTransiently()).toBe(false)
    await browserBackendError(new Response('', { status }))
    expect(backendFailedTransiently()).toBe(true)
    expect(backendFailedTransiently(Date.now() + 60_000)).toBe(false) // only the failure that just happened counts
    vi.resetModules()
  }

  const { fetchBrowserBackend, backendFailedTransiently } = await load()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
  await expect(fetchBrowserBackend('/agents/api/__hermes_backend/api/status')).rejects.toThrow()
  expect(backendFailedTransiently()).toBe(true)
})

it('没登录、没权限、接口不存在时，重试也没用：照旧显示错误', async () => {
  for (const status of [401, 403, 404, 500]) {
    const { browserBackendError, backendFailedTransiently } = await load()
    await browserBackendError(new Response('', { status }))
    expect(backendFailedTransiently()).toBe(false)
    vi.resetModules()
  }
})
