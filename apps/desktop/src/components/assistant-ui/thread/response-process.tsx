import { ThreadPrimitive, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type ComponentProps, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { registerPluginLocales, usePluginI18n } from '@/i18n/plugin-i18n'
import { Clock } from '@/lib/icons'

import { contentHasVisibleText } from './content'
import { responseDurationParts } from './response-presentation'

const SCOPE = 'desktop-mt.response-process'
registerPluginLocales(SCOPE, {
  en: {
    process: 'Execution update',
    duration: (time: string) => `Worked for ${time}`,
    time: (h: number, m: number, s: number) => (h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`)
  },
  zh: {
    process: '执行过程',
    time: (h: number, m: number, s: number) => (h ? `${h}小时${m}分钟${s}秒` : m ? `${m}分${s}秒` : `${s}秒`),
    duration: (time: string) => `用时 ${time}`
  },
  'zh-hant': {
    process: '執行過程',
    time: (h: number, m: number, s: number) => (h ? `${h}小時${m}分鐘${s}秒` : m ? `${m}分${s}秒` : `${s}秒`),
    duration: (time: string) => `用時 ${time}`
  }
})
interface ResponseProcessProps {
  indices: readonly number[]
  components: ComponentProps<typeof ThreadPrimitive.MessageByIndex>['components']
}

export function ResponseProcess({ indices, components }: ResponseProcessProps) {
  const copy = usePluginI18n(SCOPE)
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
      completed:
        last?.role === 'assistant' &&
        last.metadata?.custom?.interim !== true &&
        last.status?.type === 'complete' &&
        last.status.reason === 'stop' &&
        contentHasVisibleText(last.content),
      seconds: typeof duration === 'number' ? duration : start > 0 && end >= start ? end - start : undefined
    })
  })

  const state = JSON.parse(signature) as { live: boolean; completed: boolean; seconds?: number }

  const duration = responseDurationParts(state.seconds ?? 0)

  return (
    <>
      {!state.live && state.seconds !== undefined && (
        <div
          className="flex w-fit items-center gap-2 py-2 text-xs font-medium tabular-nums text-muted-foreground"
          data-slot="aui_turn-duration"
        >
          <Clock aria-hidden="true" className="size-3.5" />
          {copy('duration', copy('time', duration.hours, duration.minutes, duration.seconds))}
        </div>
      )}
      {indices.map(index => (
        <ResponseEntry components={components} index={index} key={index} settled={!state.live && state.completed} />
      ))}
    </>
  )
}

interface ResponseEntryProps {
  components: ResponseProcessProps['components']
  index: number
  settled: boolean
}

/** Unclassified prose remains visible, including histories without interim metadata. */
function ResponseEntry({ components, index, settled }: ResponseEntryProps) {
  const copy = usePluginI18n(SCOPE)
  const interim = useAuiState(s => s.thread.messages[index]?.metadata?.custom?.interim === true)
  const [expanded, setExpanded] = useState(false)
  const collapsible = interim && settled
  const visible = !collapsible || expanded

  return (
    <div data-slot="aui_response-entry">
      {collapsible && (
        <button
          aria-expanded={visible}
          className="py-1 text-xs text-muted-foreground hover:text-foreground"
          data-slot="aui_process-summary"
          onClick={() => setExpanded(value => !value)}
          type="button"
        >
          {copy('process')} {visible ? '⌃' : '⌄'}
        </button>
      )}
      <div hidden={!visible} style={!visible ? { display: 'none' } : undefined}>
        <ThreadPrimitive.MessageByIndex components={components} index={index} />
      </div>
    </div>
  )
}
