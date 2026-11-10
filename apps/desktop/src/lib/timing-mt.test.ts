import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  markPageStep,
  noteGatewayRequest,
  resetTimingForTests,
  type TimingRecord,
  watchGateway
} from './timing-mt'

// 召唤专家判断「准备好」看聚焦的会话在哪个 profile（host.state.focusedSessionProfile）
const { focusedSessionProfile } = vi.hoisted(() => {
  let value: null | string = null

  return { focusedSessionProfile: { get: () => value, set: (next: null | string) => void (value = next) } }
})

vi.mock('@hermes/plugin-sdk', () => ({ host: { state: { focusedSessionProfile } } }))

type Handler = (event: Record<string, unknown>) => void

function fakeGateway() {
  const handlers: Handler[] = []
  const states: ((state: string) => void)[] = []

  return {
    emit: (event: Record<string, unknown>) => handlers.forEach(handler => handler(event)),
    onEvent: (handler: Handler) => {
      handlers.push(handler)

      return () => undefined
    },
    onState: (handler: (state: string) => void) => {
      states.push(handler)
      handler('idle')

      return () => undefined
    },
    setState: (state: string) => states.forEach(handler => handler(state))
  }
}

let clock = 0
let reports: TimingRecord[] = []

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

async function rpc(gateway: object, method: string, params: Record<string, unknown>, result: unknown, ms: number) {
  let resolve!: (value: unknown) => void
  const pending = new Promise(done => (resolve = done))
  const returned = noteGatewayRequest(gateway, method, params, pending)
  expect(returned).toBe(pending) // 原样返回同一个 promise
  clock += ms
  resolve(result)
  await flush()
}

function at(ms: number) {
  clock += ms
}

beforeEach(() => {
  clock = 1_000
  reports = []
  vi.spyOn(performance, 'now').mockImplementation(() => clock)

  if (typeof performance.getEntriesByType === 'function') {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]) // 页面加载那一段在 jsdom 里没有
  }

  resetTimingForTests()
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { reportTiming: (record: TimingRecord) => reports.push(record) }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'hermesDesktop')
})

describe('chat.first_turn', () => {
  it('times the first turn of a new conversation, step by step, and only that turn', async () => {
    const gateway = fakeGateway()
    watchGateway(gateway)
    await rpc(gateway, 'session.create', {}, { session_id: 's1', info: { model: 'deepseek-v4-flash' } }, 300)
    at(20_000) // 用户打字的时间不算
    await rpc(gateway, 'file.attach', { session_id: 's1' }, {}, 100)
    void noteGatewayRequest(gateway, 'prompt.submit', { session_id: 's1', text: 'hi' }, new Promise(() => undefined))
    at(6_800)
    gateway.emit({ type: 'message.start', session_id: 's1' })
    at(3_000)
    gateway.emit({ type: 'message.delta' }) // 不带 session_id：归这条连接上刚开始回复的那句
    at(1_200)
    gateway.emit({ type: 'message.complete', session_id: 's1' })

    expect(reports).toEqual([
      {
        kind: 'chat.first_turn',
        labels: { ok: true, attachments: 1, slow_notice: false, model: 'deepseek-v4-flash' },
        seconds: 11.3,
        steps: { session: 0.3, agent: 6.8, first_token: 3, reply: 1.2 }
      }
    ])

    // 同一个会话的第二句不记
    void noteGatewayRequest(gateway, 'prompt.submit', { session_id: 's1', text: 'again' }, new Promise(() => undefined))
    gateway.emit({ type: 'message.start', session_id: 's1' })
    gateway.emit({ type: 'message.complete', session_id: 's1' })
    expect(reports).toHaveLength(1)
  })

  it('marks the slow-agent notice and failed turns', async () => {
    const gateway = fakeGateway()
    watchGateway(gateway)
    await rpc(gateway, 'session.create', {}, { session_id: 's2' }, 100)
    void noteGatewayRequest(gateway, 'prompt.submit', { session_id: 's2' }, new Promise(() => undefined))
    gateway.emit({ type: 'notification.show', payload: { id: 'agent-build-slow:default', text: '…' } })
    at(31_000)
    gateway.emit({ type: 'error', session_id: 's2' })

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ kind: 'chat.first_turn', labels: { ok: false, slow_notice: true } })
    expect(reports[0].steps).toEqual({ session: 0.1 })
  })
})

describe('bot.create', () => {
  it('links the bot to its self-introduction and reports both records', async () => {
    const gateway = fakeGateway()
    watchGateway(gateway)
    await rpc(gateway, 'profiles.create', { name: 'sales' }, { ok: true }, 2_200)
    await rpc(gateway, 'setup.runtime_check', { profile: 'sales' }, { ok: true }, 500)
    await rpc(gateway, 'session.create', { profile: 'sales' }, { session_id: 'b1' }, 300)
    at(200)
    void noteGatewayRequest(gateway, 'prompt.submit', { session_id: 'b1' }, new Promise(() => undefined))
    at(6_800)
    gateway.emit({ type: 'message.start', session_id: 'b1' })
    gateway.emit({ type: 'session.info', session_id: 'b1', payload: { model: 'glm-5.2' } })
    at(3_000)
    gateway.emit({ type: 'message.delta', session_id: 'b1' })
    at(1_000)
    gateway.emit({ type: 'message.complete', session_id: 'b1' })

    expect(reports.map(report => report.kind)).toEqual(['chat.first_turn', 'bot.create'])
    expect(reports[0].labels).toMatchObject({ bot: true, model: 'glm-5.2' })
    expect(reports[1]).toEqual({
      kind: 'bot.create',
      labels: { ok: true, slow_notice: false, model: 'glm-5.2' },
      seconds: 14,
      steps: { create: 2.2, check: 0.5, to_submit: 1, agent: 6.8, first_token: 3, reply: 1 }
    })
  })

  it('reports a failed create right away and does not link later conversations to it', async () => {
    const gateway = fakeGateway()
    watchGateway(gateway)
    const failed = noteGatewayRequest(gateway, 'profiles.create', { name: 'x' }, Promise.reject(new Error('nope')))
    await expect(failed).rejects.toThrow('nope')
    await flush()
    expect(reports).toEqual([{ kind: 'bot.create', labels: { ok: false }, seconds: 0, steps: { create: 0 } }])
  })
})

describe('page.open', () => {
  it('reports once, when the instance is connected and the conversation list is up', () => {
    const gateway = fakeGateway()
    watchGateway(gateway)
    at(1_000)
    markPageStep('account')
    at(2_500)
    markPageStep('sessions') // 会话列表走 REST，可以比连接先到
    expect(reports).toEqual([])
    at(500)
    gateway.setState('open')

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ kind: 'page.open', labels: { hidden: false }, seconds: 5 })
    expect(reports[0].steps).toEqual({ account: 2, sessions: 2.5, connect: 0.5 })

    gateway.setState('open')
    markPageStep('sessions')
    expect(reports).toHaveLength(1)
  })
})

describe('without a reporter (the desktop app)', () => {
  it('records nothing and hands the request back untouched', async () => {
    Reflect.deleteProperty(window, 'hermesDesktop')
    const gateway = fakeGateway()
    watchGateway(gateway)
    const pending = Promise.resolve({ session_id: 's9' })
    expect(noteGatewayRequest(gateway, 'session.create', {}, pending)).toBe(pending)
    await flush()
    markPageStep('sessions')
    gateway.setState('open')
    expect(reports).toEqual([])
  })
})

describe('expert.summon', () => {
  it('times summon until the expert is focused; leaving before that is not recorded', async () => {
    const { $expertSummon } = await import('@/plugins/uniwork-kits/summon-state')
    await import('./timing-summon-mt')

    $expertSummon.set({ displayName: '股票', phase: 'preparing', profile: 'stock', poolFull: false })
    at(4_200)
    focusedSessionProfile.set('stock')
    $expertSummon.set(null)
    expect(reports).toEqual([
      { kind: 'expert.summon', labels: { ok: true, pool_full: false }, seconds: 4.2, steps: { prepare: 4.2 } }
    ])

    // 准备中就离开：不记
    focusedSessionProfile.set('default')
    $expertSummon.set({ displayName: '基金', phase: 'preparing', profile: 'fund', poolFull: true })
    $expertSummon.set(null)
    expect(reports).toHaveLength(1)

    // 准备失败：记，ok 为假
    $expertSummon.set({ displayName: '基金', phase: 'preparing', profile: 'fund', poolFull: true })
    at(180_000)
    $expertSummon.set({ displayName: '基金', phase: 'failed', profile: 'fund', poolFull: true, error: 'timed out' })
    expect(reports[1]).toEqual({
      kind: 'expert.summon',
      labels: { ok: false, pool_full: true },
      seconds: 180,
      steps: { prepare: 180 }
    })
  })
})
