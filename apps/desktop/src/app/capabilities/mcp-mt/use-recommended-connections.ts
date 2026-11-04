import { useEffect, useRef, useState } from 'react'

import { capabilityScoped, type ProfileScope } from '@/api/client'
import { inlineErrorMessage } from '@/app/session/hooks/use-prompt-actions/utils'
import { isBrowserShell } from '@/lib/browser-shell'

import type {
  ConnectorId,
  LocalConnectorRequest,
  LocalConnectorResult,
  LocalConnectorRow
} from '../../../../electron/open-connector/contract'

/** One mounted scope owns its requests; late replies never paint another profile. */
export function useRecommendedConnections(scope: ProfileScope) {
  const route = capabilityScoped(scope)
  const profile = route.profile || 'default'
  const key = `${route.connectionId || ''}::${profile}`
  const generation = useRef(0)
  const [rows, setRows] = useState<LocalConnectorRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [available, setAvailable] = useState(false)
  const [pending, setPending] = useState<ConnectorId | null>(null)
  // Provider-page authorization (cloud WPS) in progress: polled until the runtime saves the token.
  const [authorization, setAuthorization] = useState<{ id: ConnectorId; sessionId: string } | null>(null)

  async function qr(
    operation: 'qr.start' | 'qr.poll' | 'qr.cancel',
    sessionId?: string
  ): Promise<LocalConnectorResult | null> {
    if (!available) {
      return null
    }

    const epoch = generation.current
    const result = await window.hermesDesktop.localConnectors({ operation, profile, id: 'wecom_bot', sessionId })

    if (generation.current !== epoch) {
      return null
    }

    if (result.qrState === 'confirmed') {
      setRows(result.connectors)
    }

    return result
  }

  // eslint-disable-next-line no-restricted-syntax -- generation counter invalidates requests; no atom is mirrored into this ref
  useEffect(() => {
    const epoch = ++generation.current
    let stopped = false
    setRows([])
    setError('')
    setAvailable(false)
    setPending(null)
    setAuthorization(null)
    setBusy(false)

    async function load() {
      try {
        const cloud = isBrowserShell() && !!window.hermesDesktop.cloudConnectorIds && (!route.connectionId || route.connectionId === 'local')
        const local = isBrowserShell() && window.hermesDesktop.cloudConnectorIds ? cloud : route.connectionId
          ? route.connectionId === 'local'
          : (await window.hermesDesktop.getConnectionConfig(profile)).mode === 'local'

        if (stopped) {
          return
        }

        setAvailable(local && typeof window.hermesDesktop.localConnectors === 'function')

        if (!local || !window.hermesDesktop.localConnectors) {
          return
        }

        const result = await window.hermesDesktop.localConnectors({ operation: 'list', profile })

        if (!stopped && generation.current === epoch) {
          setRows(result.connectors)
        }
      } catch (reason) {
        if (!stopped && generation.current === epoch) {
          setError(inlineErrorMessage(reason, ''))
        }
      }
    }

    void load()

    return () => {
      stopped = true

      generation.current = epoch + 1
    }
    // The immutable key captures both connection and profile for this lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  async function request(
    operation: LocalConnectorRequest['operation'],
    id: ConnectorId,
    values?: Record<string, string>
  ) {
    if (!available || busy) {
      return false
    }

    const epoch = generation.current
    setBusy(true)
    setError('')

    try {
      const result = await window.hermesDesktop.localConnectors({
        operation,
        profile,
        id,
        ...(values ? { values } : {})
      })

      if (generation.current !== epoch) {
        return false
      }

      setRows(result.connectors)

      if (operation === 'authorize') {
        setPending(id)

        if (result.sessionId && result.status) {
          setAuthorization({ id, sessionId: result.sessionId })
        }
      }

      return true
    } catch (reason) {
      if (generation.current === epoch) {
        setError(inlineErrorMessage(reason, ''))
      }

      return false
    } finally {
      if (generation.current === epoch) {
        setBusy(false)
      }
    }
  }

  useEffect(() => {
    if (!available || typeof window.hermesDesktop.localConnectors !== 'function') {
      return
    }

    const epoch = generation.current
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let refreshing = false

    async function refresh() {
      if (refreshing || stopped) {
        return
      }

      refreshing = true

      try {
        const result = await window.hermesDesktop.localConnectors({ operation: 'list', profile })

        if (!stopped && generation.current === epoch) {
          setRows(result.connectors)
        }
      } catch {
        // A background refresh is best-effort. Keep the last known state and retry.
      } finally {
        refreshing = false
      }
    }

    function schedule() {
      timer = setTimeout(async () => {
        await refresh()

        if (!stopped) {
          schedule()
        }
      }, 2000)
    }

    function refreshWhenVisible() {
      if (document.visibilityState === 'visible') {
        void refresh()
      }
    }

    schedule()
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)

    return () => {
      stopped = true
      clearTimeout(timer)
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
    // The refresh loop is bound to its captured local scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, key])

  // A provider-page session finishes only through its poll: that call registers the connector
  // and persists the instance, which the plain list refresh never does.
  useEffect(() => {
    if (!authorization) {
      return
    }

    const epoch = generation.current
    let stopped = false
    let timer: ReturnType<typeof setTimeout>

    async function poll() {
      try {
        const result = await window.hermesDesktop.localConnectors({
          operation: 'authorize.poll',
          profile,
          id: authorization!.id,
          sessionId: authorization!.sessionId
        })

        if (stopped || generation.current !== epoch) {
          return
        }

        setRows(result.connectors)

        if (result.status === 'connected') {
          setAuthorization(null)
          setPending(null)

          return
        }

        if (result.status === 'failed' || result.status === 'cancelled' || result.status === 'expired') {
          setAuthorization(null)
          setPending(null)
          setError(result.message || '授权未完成，请重新发起授权。')

          return
        }
      } catch {
        // A poll is best-effort; the session keeps running server-side until it expires.
      }

      if (!stopped) {
        timer = setTimeout(() => void poll(), 2000)
      }
    }

    timer = setTimeout(() => void poll(), 2000)

    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [authorization, profile])

  useEffect(() => {
    if (!pending) {
      return
    }

    if (rows.some(row => row.id === pending && row.connected)) {
      setPending(null)

      return
    }

    const timer = setTimeout(() => {
      setPending(null)
      setError('OAuth authorization timed out.')
    }, 15 * 60_000)

    return () => clearTimeout(timer)
  }, [pending, rows])

  return {
    scopeKey: key,
    rows,
    busy,
    error,
    available,
    pending,
    request,
    qr,
    capture: () => {
      const epoch = generation.current

      return () => generation.current === epoch
    },
    cancel: () => setPending(null)
  }
}
