/** 服务端主动通知（ntfy）在主进程与页面之间的唯一契约：只传业务字段，不传凭证。 */

export const NTFY_START_CHANNEL = 'hermes:ntfy:start'
export const NTFY_STOP_CHANNEL = 'hermes:ntfy:stop'
export const NTFY_EVENT_CHANNEL = 'hermes:ntfy:event'
/** 指令要求主进程重新拉取并落盘账号配置；页面据此决定要不要再读一次配置。 */
export const NTFY_REFRESH_CHANNEL = 'hermes:ntfy:refresh'

/** 刷新类指令的注册表；未注册 tag 一律静默忽略。 */
export const NTFY_INSTRUCTION_TAGS = ['refresh_plan', 'refresh_model_config', 'refresh_tool_config'] as const

export type NtfyInstructionTag = (typeof NTFY_INSTRUCTION_TAGS)[number]

/**
 * `connecting`/`online`/`retrying` 是运行状态；`stopped` 是页面不再需要订阅；
 * `unavailable` 是当前环境订阅不了（未登录、网关没开这个接口）——都不打扰用户。
 */
export type NtfyState = 'connecting' | 'online' | 'retrying' | 'stopped' | 'unavailable'

/** 断线/失败的分类，仅用于排查，不含凭证与频道名。 */
export type NtfyReason =
  | 'auth'
  | 'channel'
  | 'network'
  | 'no-account'
  | 'protocol'
  | 'throttled'
  | 'unconfigured'

export interface NtfyStatus {
  state: NtfyState
  reason?: NtfyReason
  /** 下次重连时间（Unix 毫秒）；仅 retrying 时有值。 */
  retryAt?: number
}

/** 公告：`tags` 为空的消息，进消息中心并可回溯。 */
export interface NtfyAnnouncement {
  id: string
  /** 服务端发布时间（Unix 毫秒）；缺失或不可信时取收到时间。 */
  at: number
  priority: number
  text: string
  title: string
  topic: string
}

/** 指令：`tags` 非空的消息，只触发刷新，绝不进消息中心。 */
export interface NtfyInstruction {
  id: string
  /** 已注册的 tag；未注册的 tag 在分发前就被丢弃。 */
  tags: NtfyInstructionTag[]
}

export type NtfyEvent =
  | { kind: 'announcement'; announcement: NtfyAnnouncement }
  | { kind: 'instruction'; instruction: NtfyInstruction }
  | { kind: 'status'; status: NtfyStatus }

/** 主进程按指令重拉配置的结果；`skipped` 表示当前账号走不到远端（本地配置即真相）。 */
export interface NtfyRefreshResult {
  status: 'ok' | 'skipped' | 'failed'
}
