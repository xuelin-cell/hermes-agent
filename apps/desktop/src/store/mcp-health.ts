/**
 * Background MCP health checker. On gateway connect — and every 30 minutes
 * after — probe the ACTIVE profile's enabled HTTP/SSE MCP servers and nudge
 * the user when one is in needs-auth (expired OAuth token) or error: on the
 * transition, then at most once a day while it stays broken, with a
 * one-click path to the MCP page's Authenticate button and a Disable button
 * for servers the user no longer wants.
 *
 * Scope is deliberate: stdio servers are NEVER probed here. Probing a stdio
 * server SPAWNS a local process, so a background timer would silently launch
 * user-configured commands every half hour. Only url-shaped servers (HTTP/SSE
 * — where OAuth expiry actually lives) are swept, sequentially, and through
 * the same probe cache the MCP page uses so neither surface re-probes what
 * the other just learned.
 * UniAI-Toolkit follows the backend's runtime status instead of a separate probe.
 */

import type { RpcMethods } from '@hermes/shared'

import { getHermesConfigRecord, type McpTestResult, setMcpServerEnabled, testMcpServer } from '@/hermes'
import { translateNow } from '@/i18n'
import { isPlatformMcpServer } from '@/lib/browser-shell'
import { classifyProbe, freshProbe, probeCache, probeKey } from '@/lib/mcp-probe-cache'
import { getServers, serverEnabled, UNI_AI_TOOLKIT_SERVER } from '@/lib/mcp-servers'
import { persistString, storedString } from '@/lib/storage'
import { activeGateway, activeGatewayConnectionId, gatewayActivationEpoch } from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $gatewayState } from '@/store/session'

// A constant, not a config knob: the sweep is cheap (a handful of sequential
// HTTP probes at most) and the notification is transition-gated below, so
// there is nothing for a user to meaningfully tune.
const CHECK_INTERVAL_MS = 30 * 60_000
const TOOLKIT_CHECK_INTERVAL_MS = 5_000
const TOOLKIT_STATUS_TIMEOUT_MS = 4_000
const TOOLKIT_NOTICE_DURATION_MS = 8_000

export type McpHealthStatus = 'error' | 'needs-auth' | 'ok'

/**
 * The notify decision, as a pure state machine: nudge on a TRANSITION into a
 * bad state — never for ok. An unknown previous state (first sweep of the
 * session) notifies only when its persisted cooldown is absent or elapsed,
 * so an expired token discovered at launch is still surfaced without
 * re-notifying after a renderer restart.
 *
 * A server that STAYS broken is nudged again once the daily snooze lapses:
 * a dead OAuth token is a standing problem the user has to act on (sign in
 * again, or disable the server), and a one-shot toast they closed on Monday
 * is forgotten by Wednesday. `snoozedUntil` is the persisted per-server
 * cooldown (set when a toast is shown); the recheck path re-nudges only past
 * it, so an unchanged bad state costs at most one toast per day.
 */
export function shouldNotify(
  previous: McpHealthStatus | null,
  next: McpHealthStatus,
  snoozedUntil: number,
  now: number
): boolean {
  if (next !== 'error' && next !== 'needs-auth') {
    return false
  }

  // A renderer restart clears transition memory but not the per-server
  // cooldown. Treat that first sweep as a recheck: an active persisted snooze
  // must still suppress the toast, while an unset or elapsed snooze may nudge.
  if (previous === null) {
    return now >= snoozedUntil
  }

  return previous !== next || now >= snoozedUntil
}

// Same time-based snooze the update/skew toasts use (store/updates.ts): a
// shown toast arms a 24h cooldown for that (profile, server), persisted so an
// app restart does not re-nudge before the day is up.
const SNOOZE_KEY_PREFIX = 'hermes:mcp-health-snooze-until:'
const SNOOZE_MS = 24 * 60 * 60 * 1000

function snoozedUntil(key: string): number {
  const until = Number(storedString(SNOOZE_KEY_PREFIX + key) || 0)

  return Number.isFinite(until) ? until : 0
}

function snooze(key: string): void {
  persistString(SNOOZE_KEY_PREFIX + key, String(Date.now() + SNOOZE_MS))
}

// Last-known status per (profile, server) — the transition memory. Keyed by
// profile so one profile's broken server can't mute or trigger another's
// (AGENTS.md scope-in-key).
const lastStatus = new Map<string, McpHealthStatus>()

let started = false
let timer: ReturnType<typeof setInterval> | null = null
let toolkitTimer: ReturnType<typeof setInterval> | null = null
let toolkitCheckInFlight = false
let pendingToolkitFailure: { route: number; scope: string } | null = null
const notifiedToolkitFailures = new Set<string>()
// Invalidate outstanding reads on disconnect or profile switch.
let sweepEpoch = 0
// At most one sweep runs and one follow-up is remembered. Reconnect storms
// still request a fresh pass, but cannot append an unbounded backlog.
let sweepInFlight: Promise<void> | null = null
let sweepQueued = false
let offGatewayState: (() => void) | null = null
let offProfile: (() => void) | null = null

function openMcpServerPage(name: string): void {
  window.location.hash = `#/capabilities?tab=connectors&server=${encodeURIComponent(name)}`
}

// "Disable" from the toast: `enabled: false` in config.yaml (the server stays
// listed on the MCP page for a later re-enable). The backend follows the edit
// on its own — the gateway's config reconcile and the serve backend's next
// reload both drop a disabled server — so no reload RPC is issued here.
async function disableServer(profileKey: string, name: string): Promise<void> {
  try {
    await setMcpServerEnabled(name, false)
    lastStatus.delete(`${profileKey}::${name}`)
    notify({
      kind: 'success',
      message: translateNow('notifications.mcp.disabledMessage', name)
    })
  } catch (err) {
    notifyError(err, translateNow('notifications.mcp.disableFailed', name))
  }
}

function recordResult(profileKey: string, name: string, status: McpHealthStatus): void {
  const key = `${profileKey}::${name}`
  const previous = lastStatus.get(key) ?? null
  lastStatus.set(key, status)

  // desktop-mt: the platform's MCP servers sign in with the device token; signing in to them is not the fix.
  if (!shouldNotify(previous, status, snoozedUntil(key), Date.now()) || (status === 'needs-auth' && isPlatformMcpServer(name))) {
    return
  }

  snooze(key)

  const needsAuth = status === 'needs-auth'

  notify({
    action: {
      label: translateNow(needsAuth ? 'notifications.mcp.signIn' : 'notifications.mcp.view'),
      onClick: () => openMcpServerPage(name)
    },
    id: `mcp-health-${key}`,
    kind: 'warning',
    message: translateNow(needsAuth ? 'notifications.mcp.needsAuthMessage' : 'notifications.mcp.errorMessage', name),
    secondaryAction: {
      label: translateNow('notifications.mcp.disable'),
      onClick: () => void disableServer(profileKey, name)
    },
    title: translateNow(needsAuth ? 'notifications.mcp.needsAuthTitle' : 'notifications.mcp.errorTitle')
  })
}

/** 从当前网关读取工具箱状态，连续两次确认失败后才提醒。 */
async function checkToolkitStatus(): Promise<void> {
  const gateway = activeGateway()

  if (!gateway || toolkitCheckInFlight || $gatewayState.get() !== 'open') {
    return
  }

  const epoch = sweepEpoch
  const route = gatewayActivationEpoch()
  const profile = normalizeProfileKey($activeGatewayProfile.get())
  const scope = `${activeGatewayConnectionId() ?? ''}::${profile}`
  toolkitCheckInFlight = true

  try {
    const result = await gateway
      .request<RpcMethods['mcp.servers.status']['result']>('mcp.servers.status', { profile }, TOOLKIT_STATUS_TIMEOUT_MS)
      .catch(() => null)

    if (epoch !== sweepEpoch || route !== gatewayActivationEpoch() || gateway !== activeGateway()) {
      return
    }

    const servers = Array.isArray(result?.servers) ? result.servers : null
    const status = servers?.find(server => server.name === UNI_AI_TOOLKIT_SERVER)?.status

    if (status !== 'failed') {
      pendingToolkitFailure = null

      if (status === 'connected' || status === 'disabled' || (servers && !status)) {
        notifiedToolkitFailures.delete(scope)
      }

      return
    }

    const confirmed = pendingToolkitFailure?.scope === scope && pendingToolkitFailure.route === route
    pendingToolkitFailure = { route, scope }

    if (!confirmed || notifiedToolkitFailures.has(scope)) {
      return
    }

    notifiedToolkitFailures.add(scope)
    notify({
      action: {
        label: translateNow('notifications.mcp.view'),
        onClick: () => openMcpServerPage(UNI_AI_TOOLKIT_SERVER)
      },
      durationMs: TOOLKIT_NOTICE_DURATION_MS,
      id: `mcp-health-toolkit-${scope}`,
      kind: 'warning',
      message: translateNow('notifications.mcp.connectionFailedMessage', UNI_AI_TOOLKIT_SERVER),
      title: translateNow('notifications.mcp.errorTitle')
    })
  } finally {
    toolkitCheckInFlight = false
  }
}

const isUrlServer = (server: Record<string, unknown>): boolean =>
  typeof server.url === 'string' && serverEnabled(server)

async function sweep(): Promise<void> {
  const epoch = sweepEpoch
  const profileKey = normalizeProfileKey($activeGatewayProfile.get())

  let config: Record<string, unknown>

  try {
    config = await getHermesConfigRecord()
  } catch {
    // Backend unreachable / mid-restart — the next interval tick retries.
    return
  }

  if (epoch !== sweepEpoch) {
    return
  }

  // getServers drops non-object entries (a bare `name:` in config.yaml parses
  // as `null`), so isUrlServer below never reads `.url` off a null entry.
  const servers = getServers(config)

  for (const [name, server] of Object.entries(servers)) {
    if (name === UNI_AI_TOOLKIT_SERVER || !isUrlServer(server)) {
      continue
    }

    // A profile switch or gateway drop mid-sweep stops the remaining probes.
    if (epoch !== sweepEpoch || $gatewayState.get() !== 'open') {
      return
    }

    const key = probeKey(name, server, profileKey)
    let result = freshProbe(key)

    if (!result) {
      try {
        result = await testMcpServer(name)
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err), tools: [] } as McpTestResult
      }

      if (epoch !== sweepEpoch) {
        return
      }

      probeCache.set(key, { at: Date.now(), result })
    }

    recordResult(profileKey, name, classifyProbe(result))
  }
}

function queueSweep(): void {
  if (sweepInFlight) {
    sweepQueued = true

    return
  }

  sweepInFlight = sweep()

  const settled = () => {
    sweepInFlight = null

    if (sweepQueued) {
      sweepQueued = false
      queueSweep()
    }
  }

  sweepInFlight.then(settled, settled)
}

function arm(): void {
  if (timer !== null) {
    return
  }

  queueSweep()
  timer = setInterval(queueSweep, CHECK_INTERVAL_MS)
  toolkitTimer = setInterval(() => void checkToolkitStatus(), TOOLKIT_CHECK_INTERVAL_MS)
}

function disarm(): void {
  sweepEpoch += 1
  sweepQueued = false
  pendingToolkitFailure = null

  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }

  if (toolkitTimer !== null) {
    clearInterval(toolkitTimer)
    toolkitTimer = null
  }
}

/** Wire the background checker to gateway/profile state. Idempotent. */
export function startMcpHealthChecker(): void {
  if (started || typeof window === 'undefined') {
    return
  }

  started = true

  // Never check while the gateway is disconnected: the timer only exists
  // while the active socket is open, and rearms on reconnect.
  offGatewayState = $gatewayState.subscribe((state: string) => {
    if (state === 'open') {
      arm()
    } else {
      disarm()
    }
  })

  // Profile switch: invalidate in-flight sweeps, drop the timer, and re-arm
  // for the new profile (fresh immediate sweep + fresh interval) if its
  // gateway is connected. lastStatus and the snooze keys are profile-keyed,
  // so no wipe is needed — profile A's transition memory stays intact for
  // when the user switches back.
  offProfile = $activeGatewayProfile.listen(() => {
    disarm()

    if ($gatewayState.get() === 'open') {
      arm()
    }
  })
}

export function stopMcpHealthChecker(): void {
  disarm()
  notifiedToolkitFailures.clear()
  offGatewayState?.()
  offGatewayState = null
  offProfile?.()
  offProfile = null
  started = false
}
