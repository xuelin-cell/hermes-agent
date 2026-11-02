import { net } from 'electron'

import type { LoginIdentity } from '../login/session'

import {
  NTFY_INSTRUCTION_TAGS,
  type NtfyAnnouncement,
  type NtfyInstruction,
  type NtfyInstructionTag,
  type NtfyReason,
  type NtfyStatus
} from './contract'
import { createSseParser, maskTopic, ntfyStreamUrl, ntfyTopics, sinceWindow } from './sse'
import { type NtfyTokenClient, NtfyTokenError } from './token'

/** 连接存活到这个时长才算健康——限流时服务端也会先建立再立刻断开。 */
const HEALTHY_AFTER_MS = 30_000

/** 连接阶段超时；头到手后读不设上限。 */
const CONNECT_TIMEOUT_MS = 15_000

/** 同会话内按消息 id 去重的窗口。 */
const SEEN_LIMIT = 500

/** 单条消息正文上限，防止一次异常帧把整页撑爆。 */
const MAX_TEXT = 8_000

type Tier = 'auth' | 'healthy' | 'local' | 'rejected'

const TIER_BASE: Record<Tier, number> = { auth: 5_000, healthy: 2_000, local: 2_000, rejected: 60_000 }
const TIER_CAP: Record<Tier, number> = { auth: 120_000, healthy: 2_000, local: 60_000, rejected: 300_000 }

/** 每个档位各自的起退避点，全部 ±20% 抖动，避免同账号多设备同一秒重连。 */
export function reconnectDelay(tier: Tier, attempt: number, random: () => number = Math.random): number {
  const base = TIER_BASE[tier]
  const grown = tier === 'healthy' ? base : base * 2 ** Math.max(0, attempt)
  const raw = Math.min(TIER_CAP[tier], grown)
  const jitter = raw * 0.2 * (random() * 2 - 1)

  return Math.max(1_000, Math.round(raw + jitter))
}

/** 只注册过的 tag 会变成指令；未注册的也留在返回里由调用方记录后丢弃。 */
export function registeredTags(tags: readonly string[]): NtfyInstructionTag[] {
  const known = new Set<string>(NTFY_INSTRUCTION_TAGS)

  return [...new Set(tags.filter(tag => known.has(tag)))] as NtfyInstructionTag[]
}

interface NtfyWireMessage {
  at: number
  id: string
  priority: number
  tags: string[]
  text: string
  title: string
  topic: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 解析一帧 `message`：只消费契约里列出的字段，其它字段一律忽略，
 * 保证服务端加字段不会打挂客户端。`open`/`keepalive` 与坏帧返回 null。
 */
export function parseNtfyMessage(payload: string, now: number): NtfyWireMessage | null {
  let value: unknown

  try {
    value = JSON.parse(payload)
  } catch {
    return null
  }

  if (!isRecord(value)) {
    return null
  }

  if (typeof value.event === 'string' && value.event !== 'message') {
    return null
  }

  const id = typeof value.id === 'string' ? value.id.trim() : ''

  if (!id || id.length > 200) {
    return null
  }

  const rawTime = value.time

  const at =
    typeof rawTime === 'number' && Number.isFinite(rawTime) && rawTime > 0
      ? Math.min(now, Math.floor(rawTime * 1000))
      : now

  const rawPriority = value.priority

  const priority =
    typeof rawPriority === 'number' && Number.isFinite(rawPriority)
      ? Math.min(5, Math.max(1, Math.round(rawPriority)))
      : 3

  return {
    at,
    id,
    priority,
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    text: typeof value.message === 'string' ? value.message.slice(0, MAX_TEXT) : '',
    title: typeof value.title === 'string' ? value.title.slice(0, 200) : '',
    topic: typeof value.topic === 'string' ? value.topic.slice(0, 120) : ''
  }
}

export interface NtfySubscriberOptions {
  /** 当前有效登录身份（主进程持有，不经过页面）。 */
  identity: () => LoginIdentity | null
  onAnnouncement: (announcement: NtfyAnnouncement) => void
  onInstruction: (instruction: NtfyInstruction) => void
  onStatus: (status: NtfyStatus) => void
  tokens: NtfyTokenClient
  request?: typeof fetch
  log?: (line: string) => void
  now?: () => number
  random?: () => number
}

type Attempt =
  | { kind: 'fatal'; reason: NtfyReason }
  | { kind: 'retry'; reason: NtfyReason; healthy: boolean; tier: Tier }
  | { kind: 'stop' }

/**
 * 一条长连接覆盖全部频道：先换订阅凭证，再按 `since` 回填订阅，
 * 收到消息按 `tags` 分流，断开按「连接是否真的到达过服务端」选退避档位。
 */
export class NtfySubscriber {
  private readonly now: () => number
  private readonly random: () => number
  private readonly request: typeof fetch
  private readonly log: (line: string) => void
  private readonly seen: string[] = []
  private readonly seenIds = new Set<string>()
  private readonly sleepers = new Set<() => void>()
  private abort: AbortController | null = null
  private running = false
  private status: NtfyStatus = { state: 'stopped' }
  private lastMessageAt: number | null = null

  constructor(private readonly options: NtfySubscriberOptions) {
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.request = options.request ?? ((input, init) => net.fetch(input, init))
    this.log = options.log ?? (() => undefined)
  }

  statusSnapshot(): NtfyStatus {
    return this.status
  }

  /** 幂等：已经跑着就不再起第二条连接。 */
  start(): void {
    if (this.running) {
      return
    }

    this.running = true
    this.publish({ state: 'connecting' })
    void this.loop()
  }

  stop(): void {
    this.running = false
    this.abort?.abort()
    this.abort = null
    this.wake()
    this.publish({ state: 'stopped' })
  }

  /** 系统唤醒或网络恢复：跳过当前等待，立刻重连。 */
  retryNow(): void {
    if (this.running) {
      this.wake()
    }
  }

  private async loop(): Promise<void> {
    let attempt = 0
    let tier: Tier | null = null

    while (this.running) {
      const result = await this.connectOnce()

      if (!this.running || result.kind === 'stop') {
        return
      }

      if (result.kind === 'fatal') {
        // 永久错误不再重试，但允许下一次显式 start()（例如重新登录后）。
        this.running = false
        this.log(`ntfy 停止订阅：${result.reason}`)
        this.publish({ reason: result.reason, state: 'unavailable' })

        return
      }

      const healthy = result.healthy

      if (healthy) {
        attempt = 0
        tier = null
      }

      const nextTier: Tier = result.tier
      const steady = nextTier === tier

      if (!steady) {
        attempt = 0
      }

      const delay = reconnectDelay(nextTier, attempt, this.random)
      attempt += 1
      tier = nextTier

      this.log(`ntfy 断线：${result.reason}；${Math.round(delay / 1_000)}s 后重连`)
      this.publish({ reason: result.reason, retryAt: this.now() + delay, state: 'retrying' })

      await this.wait(delay)
    }
  }

  private async connectOnce(): Promise<Attempt> {
    const identity = this.options.identity()

    if (!identity) {
      return { kind: 'fatal', reason: 'no-account' }
    }

    this.publish({ state: 'connecting' })

    let token: string

    try {
      token = await this.options.tokens.get()
    } catch (error) {
      const reason = error instanceof NtfyTokenError ? error.reason : 'network'

      // 登录态无效或网关没开这个接口：重试只会空转，交给页面/账号状态处理。
      if (reason === 'auth' || reason === 'unconfigured') {
        return { kind: 'fatal', reason }
      }

      return { kind: 'retry', reason, healthy: false, tier: reason === 'throttled' ? 'rejected' : 'local' }
    }

    const controller = new AbortController()
    this.abort = controller
    const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)
    const topics = ntfyTopics(identity.phone)
    const url = ntfyStreamUrl(topics, sinceWindow(this.lastMessageAt, this.now()))
    let response: Response

    try {
      response = await this.request(url, {
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: controller.signal
      })
    } catch {
      this.abort = null

      return { kind: 'retry', reason: 'network', healthy: false, tier: 'local' }
    } finally {
      clearTimeout(connectTimer)
    }

    this.log(`ntfy 订阅 ${topics.map(maskTopic).join(',')}（${response.status}）`)

    if (response.status === 401 || response.status === 403) {
      this.abort = null
      this.options.tokens.invalidate()

      return { kind: 'retry', reason: 'auth', healthy: false, tier: 'auth' }
    }

    if (response.status === 404) {
      this.abort = null

      return { kind: 'fatal', reason: 'channel' }
    }

    if (response.status === 429) {
      this.abort = null

      return { kind: 'retry', reason: 'throttled', healthy: false, tier: 'rejected' }
    }

    if (!response.ok || !response.body) {
      this.abort = null

      return {
        kind: 'retry',
        reason: response.ok ? 'protocol' : 'network',
        healthy: false,
        tier: response.ok ? 'local' : 'rejected'
      }
    }

    const healthy = await this.read(response)

    this.abort = null

    if (!this.running) {
      return { kind: 'stop' }
    }

    // 收到过消息或连接活过 30 秒 = 连接确实到达过服务端，2 秒固定重连；
    // 从未到达（请求没出去）按本地不可用指数退避。
    return { kind: 'retry', reason: 'network', healthy, tier: healthy ? 'healthy' : 'local' }
  }

  /** 读到流结束或被中断；返回这条连接是否算健康（收到过消息，或存活满 30 秒）。 */
  private async read(response: Response): Promise<boolean> {
    let received = false
    let lived = false

    const parser = createSseParser(payload => {
      const message = parseNtfyMessage(payload, this.now())

      if (message) {
        received = true
        this.dispatch(message)
      }
    })

    // 建立成功不等于健康：只有收到消息或存活满 30 秒才算在线（F7）。
    const healthyTimer = setTimeout(() => {
      lived = true

      if (this.running && this.status.state !== 'online') {
        this.publish({ state: 'online' })
      }
    }, HEALTHY_AFTER_MS)

    const reader = response.body?.getReader()
    const decoder = new TextDecoder()

    try {
      for (;;) {
        const chunk = await reader!.read()

        if (chunk.done) {
          break
        }

        parser.push(decoder.decode(chunk.value, { stream: true }))

        if (this.status.state !== 'online' && received) {
          this.publish({ state: 'online' })
        }

        if (!this.running) {
          break
        }
      }
    } catch {
      // 读流异常等价于连接被断开，交给上层分类重连。
    } finally {
      clearTimeout(healthyTimer)
      void reader?.cancel().catch(() => undefined)
    }

    return received || lived
  }

  private dispatch(message: NtfyWireMessage): void {
    if (!this.markSeen(message.id)) {
      return
    }

    this.lastMessageAt = this.now()

    if (message.tags.length === 0) {
      this.options.onAnnouncement({
        at: message.at,
        id: message.id,
        priority: message.priority,
        text: message.text,
        title: message.title,
        topic: message.topic
      })
      this.log(`ntfy 公告 ${message.id} ${maskTopic(message.topic)} ${message.title}`)

      return
    }

    const tags = registeredTags(message.tags)

    if (!tags.length) {
      // 未注册的 tag 不报错、不提示，只留一行排查日志。
      this.log(`ntfy 忽略未注册指令 ${message.id} ${message.tags.join(',')}`)

      return
    }

    this.options.onInstruction({ id: message.id, tags })
    this.log(`ntfy 指令 ${message.id} ${tags.join(',')}`)
  }

  /** 同会话内按消息 id 去重；回填与重连都会重放同一条消息。 */
  private markSeen(id: string): boolean {
    if (this.seenIds.has(id)) {
      return false
    }

    this.seenIds.add(id)
    this.seen.push(id)

    while (this.seen.length > SEEN_LIMIT) {
      const dropped = this.seen.shift()

      if (dropped !== undefined) {
        this.seenIds.delete(dropped)
      }
    }

    return true
  }

  private publish(status: NtfyStatus): void {
    this.status = status
    this.options.onStatus(status)
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>

      const finish = () => {
        clearTimeout(timer)
        this.sleepers.delete(finish)
        resolve()
      }

      timer = setTimeout(finish, ms)
      this.sleepers.add(finish)
    })
  }

  private wake(): void {
    for (const sleeper of [...this.sleepers]) {
      sleeper()
    }
  }
}
