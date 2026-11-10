/**
 * desktop-mt: 云版的耗时埋点，入口收（deploy/hermes-mt/entry/entry/timing_routes.py，记进审计 client.timing）。
 *
 * 只挂实例那一路：每个请求（api/client.ts 的 HermesGateway.request）、每个事件和连接状态（watchGateway），
 * 召唤专家另见 timing-summon-mt.ts。只记环节名、秒数和几项短标签，不记内容；交给垫片的 reportTiming，
 * 桌面版没有它，这里什么都不做。
 *
 * - page.open：页面开始加载 → 前端资源加载完（load）→ 账号就绪（account）→ 连上实例（connect）→ 会话列表出来（sessions）
 * - chat.first_turn：每个新会话的第一句。建会话（session）→ 发出到开始回复（agent：工具发现、MCP、模型准备）
 *   → 开始回复到首字（first_token）→ 首字到回完（reply）
 * - bot.create：建 profile（create）→ 探模型（check）→ 建好到发出自我介绍（to_submit）→ 之后三段同上
 */

export type TimingKind = 'bot.create' | 'chat.first_turn' | 'expert.summon' | 'page.open'

export interface TimingRecord {
  kind: TimingKind
  seconds: number
  steps: Record<string, number>
  labels?: Record<string, boolean | number | string>
}

interface TimingEvent {
  payload?: unknown
  replayed?: boolean
  session_id?: string
  type?: string
}

interface WatchedGateway {
  onEvent: (handler: (event: TimingEvent) => void) => () => void
  onState: (handler: (state: string) => void) => () => void
}

interface PendingBot {
  checkMs?: number
  /** 从哪个档案克隆来的；克隆要拷技能，建档案那段会长 */
  clone?: string
  createMs: number
  linked: boolean
  name: string
  noSkills: boolean
  startedAt: number
}

interface NewSession {
  attachments: number
  bot?: PendingBot
  createdAt: number
  model?: string
  /** 这条连接服务的档案（noteGatewayProfile），即这段对话是哪个 bot 的 */
  profile?: string
  sessionMs: number
  /** 存下来的会话 ID，和页面地址、侧栏里的是同一个 */
  storedId?: string
}

interface Turn extends NewSession {
  firstAt?: number
  gateway: object
  sessionId: string
  slowNotice: boolean
  startAt?: number
  submitAt: number
}

const WATCHED = new Set(['file.attach', 'profiles.create', 'prompt.submit', 'session.create', 'setup.runtime_check'])
/** 建完 bot 这么久里的第一个新会话算它的自我介绍。 */
const BOT_LINK_MS = 2 * 60_000
/** 一句话这么久还没回完就不等了；建了没用的新会话也只留这么久。 */
const TURN_TTL_MS = 15 * 60_000
/** 「agent 启动超过 30 秒」那条提示（electron/agent-build-watch 的 id）。 */
const SLOW_NOTICE = 'agent-build-slow'

const newSessions = new Map<string, NewSession>()
const turns = new Map<string, Turn>()
const pinned = new WeakMap<object, string>() // 每条连接上最近开始回复的会话：不带 session_id 的事件归它
const gatewayProfiles = new WeakMap<object, string>()
let pendingBot: null | PendingBot = null

/** 每条连接服务哪个档案（store/gateway.ts 建连接、主连接换档案时告诉这里），记录里据此写 profile。 */
export function noteGatewayProfile(gateway: object, profile: string): void {
  gatewayProfiles.set(gateway, profile)
}

const now = () => performance.now()
const seconds = (ms: number) => Math.round(Math.max(0, ms) / 10) / 100

function reporter(): ((record: TimingRecord) => void) | undefined {
  const bridge = typeof window !== 'undefined' ? window.hermesDesktop : undefined

  return typeof bridge?.reportTiming === 'function' ? bridge.reportTiming : undefined
}

export function timingEnabled(): boolean {
  return reporter() !== undefined
}

export function reportTiming(record: TimingRecord): void {
  try {
    reporter()?.(record)
  } catch {
    // 耗时只是记录，报不出去不影响页面
  }
}

function prune(at: number): void {
  for (const [id, session] of newSessions) {
    if (at - session.createdAt > TURN_TTL_MS) {
      newSessions.delete(id)
    }
  }

  for (const [id, turn] of turns) {
    if (at - turn.submitAt > TURN_TTL_MS) {
      turns.delete(id)
    }
  }

  if (pendingBot && at - pendingBot.startedAt > BOT_LINK_MS) {
    pendingBot = null
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function settled(
  gateway: object,
  method: string,
  params: Record<string, unknown>,
  startedAt: number,
  result: unknown,
  ok: boolean
): void {
  const at = now()

  if (method === 'profiles.create') {
    const clone = text(params.clone_from) || undefined
    const noSkills = params.no_skills === true

    if (ok) {
      pendingBot = { clone, createMs: at - startedAt, linked: false, name: text(params.name), noSkills, startedAt }
    } else {
      reportTiming({
        kind: 'bot.create',
        labels: { ok: false, bot: text(params.name), no_skills: noSkills, ...(clone ? { clone } : {}) },
        seconds: seconds(at - startedAt),
        steps: { create: seconds(at - startedAt) }
      })
    }
  } else if (method === 'setup.runtime_check') {
    if (pendingBot && !pendingBot.linked && text(params.profile) === pendingBot.name) {
      pendingBot.checkMs = at - startedAt
    }
  } else if (method === 'session.create' && ok) {
    const sessionId = text(record(result).session_id)

    if (sessionId) {
      const bot = pendingBot && !pendingBot.linked && at - pendingBot.startedAt <= BOT_LINK_MS ? pendingBot : undefined

      if (bot) {
        bot.linked = true
      }

      const model = text(record(record(result).info).model)

      newSessions.set(sessionId, {
        attachments: 0,
        bot,
        createdAt: at,
        model: model || undefined,
        profile: gatewayProfiles.get(gateway),
        sessionMs: at - startedAt,
        storedId: text(record(result).stored_session_id) || undefined
      })
    }
  } else if (method === 'prompt.submit' && !ok) {
    const turn = turns.get(text(params.session_id))

    if (turn) {
      finish(turn, at, false)
    }
  }
}

/** HermesGateway.request 的每个请求过一下：只看几样，原样返回同一个 promise。 */
export function noteGatewayRequest<T>(gateway: object, method: string, params: Record<string, unknown>, request: Promise<T>): Promise<T> {
  if (!WATCHED.has(method) || !timingEnabled()) {
    return request
  }

  const startedAt = now()
  prune(startedAt)

  if (method === 'prompt.submit') {
    const sessionId = text(params.session_id)
    const session = newSessions.get(sessionId)

    if (session) {
      // 只记新会话的第一句
      newSessions.delete(sessionId)
      turns.set(sessionId, { ...session, gateway, sessionId, slowNotice: false, submitAt: startedAt })
    }
  } else if (method === 'file.attach') {
    const session = newSessions.get(text(params.session_id))

    if (session) {
      session.attachments += 1
    }
  }

  request.then(
    result => settled(gateway, method, params, startedAt, result, true),
    () => settled(gateway, method, params, startedAt, undefined, false)
  )

  return request
}

function finish(turn: Turn, at: number, ok: boolean): void {
  turns.delete(turn.sessionId)
  const replyStart = turn.startAt
  const tail: Record<string, number> = {}

  if (replyStart !== undefined) {
    tail.agent = seconds(replyStart - turn.submitAt)
  }

  if (replyStart !== undefined && turn.firstAt !== undefined) {
    tail.first_token = seconds(turn.firstAt - replyStart)
  }

  if (turn.firstAt !== undefined) {
    tail.reply = seconds(at - turn.firstAt)
  }

  // 会话 ID 和页面地址里的一样，拿着它能对到是哪段对话；profile 是哪个 bot 的对话
  const session = turn.storedId || turn.sessionId

  const labels = {
    ok,
    attachments: turn.attachments,
    session,
    slow_notice: turn.slowNotice,
    ...(turn.model ? { model: turn.model } : {}),
    ...(turn.profile ? { profile: turn.profile } : {}),
    ...(turn.bot ? { bot: true } : {})
  }

  reportTiming({
    kind: 'chat.first_turn',
    labels,
    seconds: seconds(turn.sessionMs + at - turn.submitAt),
    steps: { session: seconds(turn.sessionMs), ...tail }
  })

  const bot = turn.bot

  if (bot) {
    const created = bot.startedAt + bot.createMs

    reportTiming({
      kind: 'bot.create',
      labels: {
        ok,
        bot: bot.name,
        no_skills: bot.noSkills,
        session,
        slow_notice: turn.slowNotice,
        ...(bot.clone ? { clone: bot.clone } : {}),
        ...(turn.model ? { model: turn.model } : {})
      },
      seconds: seconds(at - bot.startedAt),
      steps: {
        create: seconds(bot.createMs),
        ...(bot.checkMs !== undefined ? { check: seconds(bot.checkMs) } : {}),
        to_submit: seconds(turn.submitAt - created),
        ...tail
      }
    })
  }
}

function turnFor(gateway: object, event: TimingEvent): Turn | undefined {
  if (event.session_id) {
    return turns.get(event.session_id)
  }

  if (event.type === 'message.start') {
    // 不带 session_id 的开始：归这条连接上最近发出、还没开始回复的那句
    let latest: Turn | undefined

    for (const turn of turns.values()) {
      if (turn.gateway === gateway && turn.startAt === undefined && (!latest || turn.submitAt > latest.submitAt)) {
        latest = turn
      }
    }

    return latest
  }

  const sessionId = pinned.get(gateway)

  return sessionId ? turns.get(sessionId) : undefined
}

function onEvent(gateway: object, event: TimingEvent): void {
  if (!turns.size || event.replayed) {
    return
  }

  if (event.type === 'notification.show') {
    if (text(record(event.payload).id).includes(SLOW_NOTICE)) {
      for (const turn of turns.values()) {
        turn.slowNotice = true
      }
    }

    return
  }

  const turn = turnFor(gateway, event)

  if (!turn) {
    return
  }

  const at = now()

  switch (event.type) {
    case 'message.start':
      turn.startAt ??= at
      pinned.set(gateway, turn.sessionId)

      break

    case 'message.delta':
      turn.firstAt ??= at

      break

    case 'session.info':
      turn.model ??= text(record(event.payload).model) || undefined

      break

    case 'message.complete':
      finish(turn, at, true)

      break

    case 'error':
      finish(turn, at, false)

      break
  }
}

// ---------------------------------------------------------------- 打开页面

type PageStep = 'account' | 'connect' | 'sessions'
const pageMarks = new Map<PageStep, number>()
let pageDone = false
let pageHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'

function loadedAt(): number {
  const entry = typeof performance.getEntriesByType === 'function' ? performance.getEntriesByType('navigation')[0] : undefined
  const loaded = (entry as PerformanceNavigationTiming | undefined)?.domContentLoadedEventEnd

  return loaded && loaded > 0 ? loaded : 0
}

/** 打开页面的几个点（垫片和 watchGateway 调）：连上实例、会话列表都出来了一次报完，之后不再记。
 *  各段按实际先后算，谁先到谁在前（会话列表走的 REST 不一定等连接）。 */
export function markPageStep(step: PageStep): void {
  if (pageDone || pageMarks.has(step)) {
    return
  }

  pageMarks.set(step, now())

  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    pageHidden = true
  }

  if (!pageMarks.has('connect') || !pageMarks.has('sessions')) {
    return
  }

  pageDone = true

  if (!timingEnabled()) {
    return
  }

  const steps: Record<string, number> = {}
  let previous = loadedAt()

  if (previous > 0) {
    steps.load = seconds(previous)
  }

  for (const [name, at] of [...pageMarks.entries()].sort((a, b) => a[1] - b[1])) {
    steps[name] = seconds(at - previous)
    previous = Math.max(previous, at)
  }

  // 页面在后台打开的，浏览器会放慢它：标出来，看数据时别和前台的混在一起
  reportTiming({ kind: 'page.open', labels: { hidden: pageHidden }, seconds: seconds(previous), steps })
}

/** HermesGateway 建好时挂上：事件按会话记，连接第一次打开记为打开页面的 connect。 */
export function watchGateway(gateway: WatchedGateway): void {
  gateway.onEvent(event => onEvent(gateway, event))
  gateway.onState(state => {
    if (state === 'open') {
      markPageStep('connect')
    }
  })
}

/** 测试用：清掉所有进行中的记录。 */
export function resetTimingForTests(): void {
  newSessions.clear()
  turns.clear()
  pendingBot = null
  pageMarks.clear()
  pageDone = false
  pageHidden = false
}
