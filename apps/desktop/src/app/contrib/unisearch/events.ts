import type { GatewayEvent } from '@hermes/shared'

import { decodeWebResult } from '@/components/assistant-ui/tool/search-cards/provider'
import type { SessionOwnerRoute } from '@/store/session-request-router'
import type { SessionMessagesResponse } from '@/types/hermes'

interface Notice {
  session_id: string
  tool_call_id: string
  tool_name: string
  profile: string
  provider: string
  turn_id?: string
  timestamp: number
}
interface Route {
  runtimeId: string
  storedId: string
  owner: SessionOwnerRoute
  interrupted: boolean
  turnStartedAt?: number | null
}
interface Dependencies {
  route: (storedId: string) => Route | undefined
  read: (storedId: string, owner: SessionOwnerRoute) => Promise<SessionMessagesResponse>
  dispatch: (event: GatewayEvent) => void
  wait?: () => Promise<void>
}

/** Public plugin notices carry no content. Read results through the existing scoped transcript API. */
/** 身份通知只触发准确owner的历史读取；停止、换账号和新轮次会使旧结果失效。 */
export function createUniSearchEvents(deps: Dependencies) {
  const seen = new Map<string, number>()
  const starts = new Map<string, { at: number; turnStartedAt?: number | null }>()

  const lifecycles = new Map<
    string,
    { pluginKey: string; toolName: string; done: boolean; turnStartedAt?: number | null }
  >()

  /** 连接、Profile与会话共同定位调用，避免不同owner间去重。 */
  const routeKey = (route: Route, toolId: string) =>
    JSON.stringify([route.owner.connectionId, route.owner.profile, route.runtimeId, toolId])

  const wait = deps.wait ?? (() => new Promise(resolve => setTimeout(resolve, 500)))

  return (event: GatewayEvent): boolean => {
    const type: string = event.type

    // Native web chrome and the product bridge can report the same completion.
    // Let the first full result own the existing row; a second completion would
    // otherwise be interpreted as another occurrence of a reused tool-call id.
    if (type === 'tool.start' || type === 'tool.complete') {
      const payload = event.payload as { tool_id?: string; name?: string; result?: unknown } | undefined
      const route = event.session_id ? deps.route(event.session_id) : undefined

      if (
        route &&
        payload?.tool_id &&
        route.owner.connectionId === (event.connectionId ?? 'local') &&
        (!event.profile || event.profile === route.owner.profile)
      ) {
        const id = routeKey(route, payload.tool_id)
        const lifecycle = lifecycles.get(id)

        if (lifecycle && route.turnStartedAt && lifecycle.turnStartedAt !== route.turnStartedAt) {
          lifecycles.delete(id)
        } else if (lifecycle && lifecycle.toolName === payload.name) {
          if (lifecycle.done) {
            return true
          }

          const provider = decodeWebResult(payload.result)?.provider

          if (type === 'tool.complete' && ['unisearch', 'builtin_parse', 'unicrawl'].includes(String(provider))) {
            lifecycle.done = true
          }
        }
      }

      return false
    }

    if (type !== 'plugin.unisearch.tool.start' && type !== 'plugin.unisearch.tool.complete') {
      return false
    }

    const p = event.payload as unknown as Notice | undefined

    if (
      !p ||
      typeof p.session_id !== 'string' ||
      typeof p.tool_call_id !== 'string' ||
      !p.tool_call_id ||
      typeof p.timestamp !== 'number' ||
      !Number.isFinite(p.timestamp) ||
      !(
        (p.tool_name === 'web_search' && p.provider === 'unisearch') ||
        (p.tool_name === 'web_extract' && ['builtin_parse', 'unicrawl'].includes(p.provider))
      )
    ) {
      return true
    }

    const route = deps.route(p.session_id)
    const sourceConnection = event.connectionId ?? 'local'

    if (
      !route ||
      route.interrupted ||
      route.owner.connectionId !== sourceConnection ||
      (route.owner.targetProfile ?? route.owner.profile) !== p.profile
    ) {
      return true
    }

    const key = JSON.stringify([sourceConnection, p.profile, p.session_id, p.tool_call_id, p.turn_id])
    const phaseKey = key + type

    if (seen.has(phaseKey)) {
      return true
    }

    seen.set(phaseKey, Date.now())

    if (seen.size > 512) {
      seen.delete(seen.keys().next().value!)
    }

    const envelope = { connectionId: sourceConnection, profile: route.owner.profile, session_id: route.runtimeId }

    const lifecycleId = routeKey(route, p.tool_call_id)

    if (type.endsWith('.start')) {
      lifecycles.set(lifecycleId, {
        pluginKey: key,
        toolName: p.tool_name,
        done: false,
        turnStartedAt: route.turnStartedAt
      })

      if (lifecycles.size > 512) {
        lifecycles.delete(lifecycles.keys().next().value!)
      }

      starts.set(key, { at: p.timestamp, turnStartedAt: route.turnStartedAt })

      if (starts.size > 256) {
        starts.delete(starts.keys().next().value!)
      }

      deps.dispatch({
        ...envelope,
        type: 'tool.start',
        payload: {
          name: p.tool_name,
          tool_id: p.tool_call_id,
          args: { _web_provider: p.provider },
          timestamp: p.timestamp
        }
      } as GatewayEvent)

      return true
    }

    const began = starts.get(key)
    const lifecycle = lifecycles.get(lifecycleId)

    // A completion without a start cannot safely attach to an already sealed assistant bubble.
    if (began === undefined || !lifecycle || lifecycle.pluginKey !== key || lifecycle.done) {
      starts.delete(key)

      return true
    }

    /** 新轮次开始后不把旧工具结果补进当前回答。 */
    const sameTurn = (r: Route) => !r.turnStartedAt || r.turnStartedAt === began.turnStartedAt

    void (async () => {
      try {
        for (let attempt = 0; attempt < 30; attempt++) {
          if (lifecycle.done) {
            return
          }

          const current = deps.route(p.session_id)

          if (
            !current ||
            current.interrupted ||
            !sameTurn(current) ||
            current.runtimeId !== route.runtimeId ||
            JSON.stringify(current.owner) !== JSON.stringify(route.owner)
          ) {
            return
          }

          const page = await deps.read(route.storedId, route.owner)

          if (page.session_id !== route.storedId || (page.profile && page.profile !== p.profile)) {
            return
          }

          const row = [...page.messages]
            .reverse()
            .find(
              m =>
                m.role === 'tool' &&
                m.tool_call_id === p.tool_call_id &&
                (m.tool_name ?? m.name) === p.tool_name &&
                (m.timestamp ?? 0) >= began.at - 0.01
            )

          if (lifecycle.done) {
            return
          }

          const result = decodeWebResult(row?.content)

          if (row && result && result.provider === p.provider) {
            // Recheck after the asynchronous read: switching accounts or stopping invalidates the target.
            const latest = deps.route(p.session_id)

            if (
              !latest ||
              latest.interrupted ||
              !sameTurn(latest) ||
              latest.runtimeId !== route.runtimeId ||
              JSON.stringify(latest.owner) !== JSON.stringify(route.owner)
            ) {
              return
            }

            lifecycle.done = true
            deps.dispatch({
              ...envelope,
              type: 'tool.complete',
              payload: {
                name: p.tool_name,
                tool_id: p.tool_call_id,
                result,
                args:
                  p.tool_name === 'web_search' && typeof result.query === 'string'
                    ? { query: result.query }
                    : undefined,
                timestamp: row.timestamp ?? p.timestamp
              }
            } as GatewayEvent)

            return
          }

          await wait()
        }
      } catch {
        // A disconnected or unauthorized transcript is never replaced by an ambient account read.
      } finally {
        starts.delete(key)
      }
    })()

    return true
  }
}
