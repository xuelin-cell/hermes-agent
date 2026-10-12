import type { PropsWithChildren } from 'react'
import type * as ReactDomClient from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({ root: null as ReactDomClient.Root | null, api: vi.fn() }))
const legacyKeys = ['auth_token', 'user_info', 'api_token_info', 'auth_application']

// 只替换桌面内容与无关外观，实际入口、React 根、路由和旧登录拦截均参与运行。
vi.mock('./app', () => ({ default: () => <main data-testid="native-desktop">Native account desktop</main> }))
vi.mock('./store/active-work', () => ({}))
vi.mock('./store/power', () => ({}))
vi.mock('./store/translucency', () => ({}))
vi.mock('./store/user-bubble-transparency', () => ({}))
vi.mock('@/debug/dev-only', () => ({}))
vi.mock('./app/chat/perf-probe', () => ({}))
vi.mock('./components/error-boundary', () => ({ RootErrorBoundary: ({ children }: PropsWithChildren) => children }))
vi.mock('./components/haptics-provider', () => ({ HapticsProvider: ({ children }: PropsWithChildren) => children }))
vi.mock('./components/ui/tooltip', () => ({ RootTooltipProvider: ({ children }: PropsWithChildren) => children }))
vi.mock('./i18n/profile-provider', () => ({ ProfileI18nProvider: ({ children }: PropsWithChildren) => children }))
vi.mock('./themes/context', () => ({ ThemeProvider: ({ children }: PropsWithChildren) => children }))
vi.mock('./lib/renderer-loop-pause', () => ({ installRendererAnimationPauseState: vi.fn() }))
vi.mock('./lib/selection-copy-colors', () => ({ installSelectionCopyColorGuard: vi.fn() }))
vi.mock('./api/client', () => ({ hermesApi: probe.api }))
vi.mock('react-dom/client', async importOriginal => {
  const original = await importOriginal<typeof ReactDomClient>()

  return {
    ...original,
    // 保存真实 React 根，逐次卸载，避免测试间残留页面。
    createRoot: (...args: Parameters<typeof original.createRoot>) => (probe.root = original.createRoot(...args))
  }
})

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  window.document.body.innerHTML = '<div id="root"></div>'
  probe.api.mockResolvedValue({ code: 0, data: { captchaId: 'fixture', b64s: '' } })
})

afterEach(async () => {
  const { act } = await import('react')
  await act(() => probe.root?.unmount())
  probe.root = null
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  window.document.body.innerHTML = ''
})

for (const stored of [false, true]) {
  it(stored ? '旧 Web 身份不能控制原生桌面入口，原缓存与草稿原样保留' : '没有 Web 凭据也直接进入已准备的原生桌面', async () => {
    if (stored) {
      localStorage.setItem('auth_token', 'other-account-token')
      localStorage.setItem('user_info', JSON.stringify({ uid: 'other-account', expiresAt: '2020-01-01T00:00:00Z' }))
      localStorage.setItem('api_token_info', 'invalid-old-json')
      localStorage.setItem('auth_application', 'uniwork')
    }

    localStorage.setItem('hermes:composer-drafts:v3', 'native-account-draft')
    const before = { ...localStorage }
    const reads = vi.spyOn(Storage.prototype, 'getItem')
    const removals = vi.spyOn(Storage.prototype, 'removeItem')
    const { act } = await import('react')

    await act(async () => { await import('./main') })
    expect(window.document.querySelector('[data-testid="native-desktop"]')).toBeTruthy()
    expect(probe.api).not.toHaveBeenCalled()
    expect(reads.mock.calls.filter(([key]) => legacyKeys.includes(key))).toEqual([])
    expect(removals.mock.calls.filter(([key]) => legacyKeys.includes(key))).toEqual([])
    expect({ ...localStorage }).toEqual(before)
  }, 30_000)
}
