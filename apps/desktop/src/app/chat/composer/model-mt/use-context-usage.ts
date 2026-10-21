import { useStore } from '@nanostores/react'
import { computed } from 'nanostores'
import { useEffect, useMemo, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import type { HermesGateway } from '@/hermes'
import { $currentUsage } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import type { ContextBreakdown, UsageStats } from '@/types/hermes'

import { composerContextUsage } from './context-usage'
import { useComposerModelMeta } from './model-meta'

export interface ComposerContextProps {
  busy: boolean
  gateway: HermesGateway | null
  sessionId: string | null
}

const EMPTY_USAGE: UsageStats = { calls: 0, input: 0, output: 0, total: 0 }

/** 读取当前窗格用量；只在空闲时请求明细，并丢弃换会话或模型后的旧响应。 */
export function useComposerContextUsage({ busy, gateway, sessionId }: ComposerContextProps) {
  const view = useSessionView()
  const model = useStore(view.$model)
  const provider = useStore(view.$provider)

  const $usage = useMemo(
    () =>
      view.kind === 'primary'
        ? $currentUsage
        : computed($sessionStates, states => (sessionId ? states[sessionId]?.usage : undefined) ?? EMPTY_USAGE),
    [view.kind, sessionId]
  )

  const usage = useStore($usage)
  const { find } = useComposerModelMeta()

  const [fetched, setFetched] = useState<{
    gateway: HermesGateway
    sessionId: string
    model: string
    provider: string
    breakdown: ContextBreakdown
  } | null>(null)

  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setFetched(null)

    if (busy || !gateway || !sessionId) {
      setLoading(false)

      return
    }

    let cancelled = false
    setLoading(true)
    void gateway
      .request<ContextBreakdown>('session.context_breakdown', { session_id: sessionId })
      .then(breakdown => {
        if (!cancelled && breakdown) {
          setFetched({ gateway, sessionId, model, provider, breakdown })
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [busy, gateway, sessionId, model, provider])

  const breakdown =
    !busy &&
    fetched?.gateway === gateway &&
    fetched?.sessionId === sessionId &&
    fetched?.model === model &&
    fetched?.provider === provider
      ? (fetched?.breakdown ?? null)
      : null

  const context = composerContextUsage({
    configurationMax: find(provider, model)?.contextWindow,
    fresh: !sessionId,
    breakdown,
    usage
  })

  return {
    context,
    breakdown,
    loading,
    usage: context
      ? {
          ...usage,
          context_used: context.used,
          context_max: context.max,
          context_percent: context.percent,
          context_estimated: context.estimated
        }
      : usage
  }
}
