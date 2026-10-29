import './response-process.css'

import { ThreadPrimitive, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type ComponentProps, useMemo, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { registerPluginLocales, usePluginI18n } from '@/i18n/plugin-i18n'
import { ChevronRight, Clock } from '@/lib/icons'

import { responseDurationParts, ResponsePresentation } from './response-presentation'

const SCOPE = 'desktop-mt.response-process'
registerPluginLocales(SCOPE, {
  en: {
    duration: (time: string) => `Worked for ${time}`,
    time: (h: number, m: number, s: number) => (h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`),
    process: 'Execution steps',
    step: (n: number) => `Step ${n}`
  },
  zh: {
    time: (h: number, m: number, s: number) => (h ? `${h}小时${m}分钟${s}秒` : m ? `${m}分${s}秒` : `${s}秒`),
    duration: (time: string) => `用时 ${time}`,
    process: '执行过程',
    step: (n: number) => `步骤 ${n}`
  },
  'zh-hant': {
    time: (h: number, m: number, s: number) => (h ? `${h}小時${m}分鐘${s}秒` : m ? `${m}分${s}秒` : `${s}秒`),
    duration: (time: string) => `用時 ${time}`,
    process: '執行過程',
    step: (n: number) => `步驟 ${n}`
  }
})
interface ResponseProcessProps {
  indices: readonly number[]
  components: ComponentProps<typeof ThreadPrimitive.MessageByIndex>['components']
}

export function ResponseProcess({ indices, components }: ResponseProcessProps) {
  const copy = usePluginI18n(SCOPE)
  const [expanded, setExpanded] = useState(false)
  const view = useSessionView()
  const busy = useStore(view.$busy)
  const awaiting = useStore(view.$awaitingResponse)

  const signature = useAuiState(s => {
    const lastIndex = indices.at(-1) ?? -1
    const last = s.thread.messages[lastIndex]
    const live = lastIndex === s.thread.messages.length - 1 && (s.thread.isRunning || busy || awaiting)
    const first = s.thread.messages[indices[0]!]
    const prompt = s.thread.messages[Math.max(0, indices[0]! - 1)]

    const start = Number(
      prompt?.metadata?.custom?.timelineTimestamp ??
        first?.metadata?.custom?.timelineTimestamp ??
        (prompt?.createdAt?.getTime() ?? first?.createdAt?.getTime() ?? 0) / 1000
    )

    const end = Number(
      last?.metadata?.custom?.timelineCompletedAt ??
        last?.metadata?.custom?.timelineTimestamp ??
        (last?.createdAt?.getTime() ?? 0) / 1000
    )

    const duration = last?.metadata?.custom?.durationS

    return JSON.stringify({
      live: live || last?.status?.type === 'running',
      seconds: typeof duration === 'number' ? duration : start > 0 && end >= start ? end - start : undefined
    })
  })

  const state = JSON.parse(signature) as { live: boolean; seconds?: number }

  const presentation = useMemo(() => ({ expanded, live: state.live }), [expanded, state.live])
  const duration = responseDurationParts(state.seconds ?? 0)

  return (
    <ResponsePresentation.Provider value={presentation}>
      {!state.live && (
        <button
          aria-expanded={expanded}
          className="response-process-summary group/process flex w-fit items-center gap-2 rounded-md py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          data-slot="aui_process-summary"
          onClick={() => setExpanded(!expanded)}
          type="button"
        >
          <Clock aria-hidden="true" className="size-3.5" />
          {state.seconds === undefined
            ? copy('process')
            : copy('duration', copy('time', duration.hours, duration.minutes, duration.seconds))}
          <ChevronRight className={`size-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>
      )}
      {indices.map((index, position) => {
        const current = position === indices.length - 1

        return (
          <div
            className="response-process-entry data-[process-settled=true]:[&_[data-slot=tool-block]]:hidden data-[process-settled=true]:[&_[data-slot=aui_thinking-disclosure]]:hidden"
            data-process-settled={!state.live && !expanded ? 'true' : undefined}
            hidden={!current && !state.live && !expanded}
            key={index}
            style={!current && !state.live && !expanded ? { display: 'none' } : undefined}
          >
            <details data-slot="aui_process-step" open={current || (!state.live && expanded)}>
              <summary className={current ? 'hidden' : 'cursor-pointer py-1 text-xs text-muted-foreground'}>
                {copy('step', position + 1)}
              </summary>
              <ThreadPrimitive.MessageByIndex components={components} index={index} />
            </details>
          </div>
        )
      })}
    </ResponsePresentation.Provider>
  )
}
