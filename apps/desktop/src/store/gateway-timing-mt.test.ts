import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// desktop-mt: 云版耗时埋点要知道每条连接是哪个档案的（lib/timing-mt.ts 的 noteGatewayProfile）
const timing = vi.hoisted(() => ({ noteGatewayProfile: vi.fn() }))
const secondaries: object[] = []

vi.mock('@/lib/timing-mt', async importOriginal => ({ ...(await importOriginal<object>()), ...timing }))
vi.mock('@/hermes', () => ({
  HermesGateway: class {
    connectionState = 'closed'
    connect = vi.fn(async () => {
      this.connectionState = 'open'
    })
    request = vi.fn(async (method: string, params: Record<string, unknown>) => ({ method, params }))
    close = vi.fn()
    onEvent = vi.fn(() => () => {})
    onState = vi.fn(() => () => {})

    constructor() {
      secondaries.push(this)
    }
  },
  setApiRequestConnection: vi.fn()
}))
vi.mock('@/store/session', () => ({ setConnection: vi.fn(), setGatewayState: vi.fn() }))
vi.mock('@/store/notify-baseline', () => ({ markNativeNotifyBaseline: vi.fn() }))

const { closeSecondaryGateways, configureGatewayRegistry, requestGatewayForProfile, setPrimaryGateway } =
  await import('./gateway')

beforeEach(() => {
  secondaries.length = 0
  configureGatewayRegistry({ onEvent: vi.fn() })
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    getConnection: vi.fn(async (profile: null | string) => ({ port: 4242, profile, token: 't' })),
    touchBackend: vi.fn(async () => undefined)
  }
})

afterEach(() => {
  closeSecondaryGateways()
  vi.clearAllMocks()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

it('tells the timing hooks which profile the primary and each pooled connection serve', async () => {
  const primary = { connectionState: 'open', request: vi.fn(async () => ({})) }

  setPrimaryGateway(primary as never, 'default')
  expect(timing.noteGatewayProfile).toHaveBeenCalledWith(primary, 'default')

  await requestGatewayForProfile('sales', 'profiles.list', {})
  expect(secondaries).toHaveLength(1)
  expect(timing.noteGatewayProfile).toHaveBeenCalledWith(secondaries[0], 'sales')
})
