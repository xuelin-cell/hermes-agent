import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import type { LoginIdentity } from '../login/session'

import type { NtfyAnnouncement, NtfyInstruction, NtfyStatus } from './contract'
import { maskTopic, ntfyStreamUrl, ntfyTopics, sinceWindow } from './sse'
import { NtfySubscriber, parseNtfyMessage, reconnectDelay, registeredTags } from './subscriber'
import type { NtfyTokenClient } from './token'

const NOW = 1_800_000_000_000

const IDENTITY: LoginIdentity = {
  expiresAt: NOW + 3_600_000,
  maskedPhone: '138****0000',
  phone: '13800000000',
  token: 'login-jwt',
  uid: 'u-1'
}

const encoder = new TextEncoder()

function frame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 有限长度的 SSE 响应：喂完就结束，等价于服务端断开连接。 */
function streamedResponse(chunks: readonly string[], status = 200): Response {
  let index = 0

  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index]))
          index += 1

          return
        }

        controller.close()
      }
    }),
    { headers: { 'Content-Type': 'text/event-stream' }, status }
  )
}

function stubTokens(): NtfyTokenClient & { invalidate: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async () => 'tk-subscription'),
    invalidate: vi.fn()
  } as unknown as NtfyTokenClient & { invalidate: ReturnType<typeof vi.fn> }
}

function createSubscriber(
  request: ReturnType<typeof vi.fn>,
  statuses: NtfyStatus[] = [],
  sinks: { announcements: NtfyAnnouncement[]; instructions: NtfyInstruction[] } = {
    announcements: [],
    instructions: []
  }
) {
  const tokens = stubTokens()

  const subscriber = new NtfySubscriber({
    identity: () => IDENTITY,
    now: () => NOW,
    onAnnouncement: announcement => sinks.announcements.push(announcement),
    onInstruction: instruction => sinks.instructions.push(instruction),
    onStatus: status => statuses.push(status),
    random: () => 0.5,
    request: request as unknown as typeof fetch,
    tokens
  })

  return { sinks, subscriber, statuses, tokens }
}

describe('ntfy 频道与回填窗口', () => {
  it('组装去重并只在有合法手机号时订阅个人频道', () => {
    expect(ntfyTopics('13800000000')).toEqual(['uniwork', 'uniwork_13800000000', 'uniclaw_13800000000'])
    expect(ntfyTopics(undefined)).toEqual(['uniwork'])
    expect(ntfyTopics('138 0000')).toEqual(['uniwork'])
  })

  it('按距最后一条消息的时长取回填窗口', () => {
    expect(sinceWindow(null, NOW)).toBe('12h')
    expect(sinceWindow(NOW - 10_000, NOW)).toBe('1m')
    expect(sinceWindow(NOW - 5 * 60_000, NOW)).toBe('5m')
    expect(sinceWindow(NOW - 3 * 3_600_000, NOW)).toBe('3h')
  })

  it('凭证不进 URL，只按频道与窗口拼地址', () => {
    const url = ntfyStreamUrl(['uniwork', 'uniwork_13800000000'], '12h')

    expect(url).toBe('https://maas.ai-yuanjing.com/app/ntfy/uniwork,uniwork_13800000000/sse?since=12h')
    expect(url).not.toContain('tk-')
  })

  it('日志里的频道名打码手机号', () => {
    expect(maskTopic('uniwork_13800000000')).toBe('uniwork_138****0000')
    expect(maskTopic('uniwork')).toBe('uniwork')
  })
})

describe('退避档位', () => {
  it('健康断开固定 2 秒，其它档位指数增长到各自上限', () => {
    expect(reconnectDelay('healthy', 0, () => 0.5)).toBe(2_000)
    expect(reconnectDelay('healthy', 9, () => 0.5)).toBe(2_000)
    expect(reconnectDelay('local', 0, () => 0.5)).toBe(2_000)
    expect(reconnectDelay('local', 5, () => 0.5)).toBe(60_000)
    expect(reconnectDelay('rejected', 0, () => 0.5)).toBe(60_000)
    expect(reconnectDelay('rejected', 9, () => 0.5)).toBe(300_000)
    expect(reconnectDelay('auth', 0, () => 0.5)).toBe(5_000)
    expect(reconnectDelay('auth', 9, () => 0.5)).toBe(120_000)
  })

  it('等待时间带 ±20% 抖动', () => {
    expect(reconnectDelay('local', 1, () => 0)).toBe(3_200)
    expect(reconnectDelay('local', 1, () => 1)).toBe(4_800)
  })
})

describe('消息解析与分流', () => {
  it('忽略控制帧与坏帧，只解析 message', () => {
    expect(parseNtfyMessage('{"event":"open"}', NOW)).toBeNull()
    expect(parseNtfyMessage('{"event":"keepalive"}', NOW)).toBeNull()
    expect(parseNtfyMessage('{"event":"message"}', NOW)).toBeNull()
    expect(parseNtfyMessage('not json', NOW)).toBeNull()
  })

  it('缺省字段落到契约默认值，多余字段忽略', () => {
    const parsed = parseNtfyMessage(
      JSON.stringify({ event: 'message', id: 'm-1', title: 't', message: 'b', extra: { x: 1 } }),
      NOW
    )

    expect(parsed).toEqual({ at: NOW, id: 'm-1', priority: 3, tags: [], text: 'b', title: 't', topic: '' })
  })

  it('priority 收敛到 1–5，tags 只保留字符串', () => {
    const parsed = parseNtfyMessage(
      JSON.stringify({ id: 'm-2', priority: 9, tags: ['refresh_plan', 3, null] }),
      NOW
    )

    expect(parsed?.priority).toBe(5)
    expect(parsed?.tags).toEqual(['refresh_plan'])
  })

  it('只认注册表里的指令 tag，重复合并', () => {
    expect(registeredTags(['refresh_plan', 'refresh_plan', 'warning'])).toEqual(['refresh_plan'])
    expect(registeredTags(['warning'])).toEqual([])
  })
})

describe('订阅连接', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('公告进消息中心、指令触发刷新、未注册 tag 静默忽略，重复 id 只处理一次', async () => {
    const request = vi.fn(async () =>
      streamedResponse([
        frame({ event: 'open' }),
        frame({ event: 'keepalive' }),
        frame({ event: 'message', id: 'a-1', message: '正文', time: 1_700_000_000, title: '版本更新', topic: 'uniwork' }),
        frame({ event: 'message', id: 'a-1', message: '正文', time: 1_700_000_000, title: '版本更新', topic: 'uniwork' }),
        frame({ event: 'message', id: 'c-1', tags: ['refresh_plan', 'refresh_model_config'], topic: 'uniwork' }),
        frame({ event: 'message', id: 'c-2', tags: ['warning'], topic: 'uniwork' })
      ])
    )

    const { sinks, subscriber } = createSubscriber(request)

    subscriber.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(sinks.announcements).toEqual([
      { at: 1_700_000_000_000, id: 'a-1', priority: 3, text: '正文', title: '版本更新', topic: 'uniwork' }
    ])
    expect(sinks.instructions).toEqual([{ id: 'c-1', tags: ['refresh_plan', 'refresh_model_config'] }])

    subscriber.stop()
  })

  it('用请求头带订阅凭证，首次回填 12 小时', async () => {
    const request = vi.fn(async () => streamedResponse([]))
    const { subscriber } = createSubscriber(request)

    subscriber.start()
    await vi.advanceTimersByTimeAsync(0)

    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit]

    expect(url).toContain('since=12h')
    expect(init.headers).toEqual({ Accept: 'text/event-stream', Authorization: 'Bearer tk-subscription' })
    expect(url).not.toContain('tk-subscription')

    subscriber.stop()
  })

  it('凭证失效：清缓存并按 auth 档位 5 秒起重连', async () => {
    const request = vi.fn(async () => streamedResponse([], 401))
    const { statuses, subscriber, tokens } = createSubscriber(request)

    subscriber.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(tokens.invalidate).toHaveBeenCalled()

    const retrying = statuses.filter(status => status.state === 'retrying')

    expect(retrying[0]?.reason).toBe('auth')
    expect(retrying[0]?.retryAt).toBe(NOW + 5_000)

    subscriber.stop()
  })

  it('频道不存在是永久错误，停止重试', async () => {
    const request = vi.fn(async () => streamedResponse([], 404))
    const { subscriber, statuses } = createSubscriber(request)

    subscriber.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(statuses.at(-1)).toEqual({ reason: 'channel', state: 'unavailable' })
    expect(request).toHaveBeenCalledTimes(1)

    subscriber.stop()
  })

  it('限流按推送服务拒绝档位 60 秒起退避', async () => {
    const request = vi.fn(async () => streamedResponse([], 429))
    const { statuses, subscriber } = createSubscriber(request)

    subscriber.start()
    await vi.advanceTimersByTimeAsync(0)

    const retrying = statuses.filter(status => status.state === 'retrying')

    expect(retrying[0]).toEqual({ reason: 'throttled', retryAt: NOW + 60_000, state: 'retrying' })

    subscriber.stop()
  })

  it('没收到消息的连接要存活 30 秒才算在线', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null

    const request = vi.fn(
      async () => new Response(new ReadableStream<Uint8Array>({ start: next => void (controller = next) }))
    )

    const { subscriber, statuses } = createSubscriber(request)

    subscriber.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(statuses.at(-1)?.state).toBe('connecting')

    await vi.advanceTimersByTimeAsync(30_000)

    expect(statuses.at(-1)?.state).toBe('online')

    subscriber.stop()
    controller?.close()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('存活满 30 秒后再断开按健康档固定 2 秒重连', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null

    const request = vi.fn(
      async () => new Response(new ReadableStream<Uint8Array>({ start: next => void (controller = next) }))
    )

    const { subscriber, statuses } = createSubscriber(request)

    subscriber.start()
    await vi.advanceTimersByTimeAsync(30_000)
    controller?.close()
    await vi.advanceTimersByTimeAsync(0)

    const retrying = statuses.filter(status => status.state === 'retrying')

    expect(retrying[0]?.retryAt).toBe(NOW + 2_000)

    subscriber.stop()
  })
})
