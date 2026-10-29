import { ThreadPrimitive, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type ComponentProps, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { formatElapsed } from '@/components/chat/activity-timer'
import { registerPluginLocales, usePluginI18n } from '@/i18n/plugin-i18n'
import { ChevronRight } from '@/lib/icons'

const SCOPE = 'desktop-mt.response-process'
registerPluginLocales(SCOPE, {
  en: {
    duration: (time: string) => `Worked for ${time}`,
    process: 'Execution steps',
    step: (n: number) => `Step ${n}`
  },
  zh: { duration: (time: string) => `用时 ${time}`, process: '执行过程', step: (n: number) => `步骤 ${n}` },
  'zh-hant': { duration: (time: string) => `用時 ${time}`, process: '執行過程', step: (n: number) => `步驟 ${n}` }
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

  return (
    <>
      {!state.live && (
        <button
          aria-expanded={expanded}
          className="flex w-full items-center gap-1 border-b border-border/50 pb-3 text-left text-sm text-muted-foreground hover:text-foreground"
          data-slot="aui_process-summary"
          onClick={() => setExpanded(!expanded)}
          type="button"
        >
          {state.seconds === undefined ? copy('process') : copy('duration', formatElapsed(state.seconds))}
          <ChevronRight className={`size-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>
      )}
      {indices.map((index, position) => {
        const current = position === indices.length - 1

        return (
          <div
            className="data-[process-settled=true]:[&_[data-slot=tool-block]]:hidden data-[process-settled=true]:[&_[data-slot=aui_thinking-disclosure]]:hidden"
            data-process-settled={!state.live && !expanded ? 'true' : undefined}
            hidden={!current && !state.live && !expanded}
            key={index}
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
    </>
  )
}
