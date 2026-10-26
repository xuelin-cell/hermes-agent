import { setShowReasoningFromConfig } from '@/store/reasoning-disclosure'

// `/reasoning` typed into the composer — the Ink TUI's path
// (ui-tui/src/app/slash/commands/session.ts). The gateway's `config.set
// key=reasoning` handles both the display words (show/hide/full/clamp) and the
// effort levels; through `slash.exec` the words only reached config.yaml and
// the transcript kept rendering Thinking until the next config refresh.

const GLOBAL_FLAGS = new Set(['--global', '-g', 'global'])
const SESSION_FLAGS = new Set(['--session', '-s', 'session'])

export type ReasoningSlashParams = {
  key: 'reasoning'
  scope?: 'global' | 'session'
  session_id: string
  value: string
}

/** Build the `config.set` params for `/reasoning <arg>`; `null` when there is nothing to set. */
export function reasoningSlashParams(arg: string, sessionId: string): null | ReasoningSlashParams {
  let scope: ReasoningSlashParams['scope']
  const values: string[] = []

  for (const part of arg.trim().split(/\s+/).filter(Boolean)) {
    const flag = part.toLowerCase()

    if (GLOBAL_FLAGS.has(flag)) {
      scope = 'global'
    } else if (SESSION_FLAGS.has(flag)) {
      scope = 'session'
    } else {
      values.push(part)
    }
  }

  if (!values.length) {
    return null
  }

  return { key: 'reasoning', session_id: sessionId, value: values.join(' '), ...(scope ? { scope } : {}) }
}

/**
 * Mirror the gateway's answer into the renderer: `hide`/`show` are the
 * `display.show_reasoning` words; effort levels leave the display gate alone.
 */
export function applyReasoningSlashResult(value: unknown): void {
  if (value === 'hide') {
    setShowReasoningFromConfig(false)
  } else if (value === 'show') {
    setShowReasoningFromConfig(true)
  }
}

// desktop-mt: 思考深度一律用服务器默认，/reasoning 只保留这几个显示用的词。
const DISPLAY_WORDS = new Set(['show', 'hide', 'full', 'clamp'])

/** 这次 /reasoning 是否想改思考深度（含显示词以外的内容）；桌面版拒绝这类调整。 */
export function reasoningSlashSetsEffort(params: ReasoningSlashParams): boolean {
  return params.value
    .split(/\s+/)
    .filter(Boolean)
    .some(word => !DISPLAY_WORDS.has(word.toLowerCase()))
}
