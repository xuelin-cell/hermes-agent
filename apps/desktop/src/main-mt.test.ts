import { expect, it, vi } from 'vitest'

const { loaded } = vi.hoisted(() => ({ loaded: vi.fn() }))

vi.mock('./dev/browser-bridge', () => ({}))
vi.mock('./main', () => {
  loaded()

  return {}
})

it('loads the app only after the browser build has wired the account', async () => {
  let settle = () => {}

  const accountReady = new Promise<void>(resolve => {
    settle = resolve
  })

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { accountReady } })

  await import('./main-mt')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(loaded).not.toHaveBeenCalled()

  settle()
  await vi.waitFor(() => expect(loaded).toHaveBeenCalledOnce())
})
