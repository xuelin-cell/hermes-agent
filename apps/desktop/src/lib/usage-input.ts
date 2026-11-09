import type { TelemetryInput } from '../../electron/uniwork-telemetry/inputs'

export interface SkillTagUsage {
  id: string
  name?: string
}

/** The gateway has accepted this user request; later model failure does not undo tag use. */
export async function reportSkillTagUsage(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  sessionId: string,
  id: string,
  tag: SkillTagUsage
): Promise<void> {
  try {
    await request('command.dispatch', {
      session_id: sessionId, name: 'usage-report',
      arg: 'tag ' + JSON.stringify({ id, tag, occurredAt: new Date().toISOString() })
    })
  } catch {
    console.warn('[uniwork-telemetry] skill tag handoff failed')
  }
}

/** Called immediately before submission. This bookkeeping must never turn a successful send into an error. */
export async function rememberUsageInput(
  id: string, profile: string, sessionId: string, requestText: string, userInput?: string,
  intent: Pick<TelemetryInput, 'requestKind' | 'resumeFrom'> = { requestKind: 'user' }
): Promise<void> {
  const record = window.hermesDesktop?.rememberUsageInput

  if (!record) {return}

  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestText))
    const requestHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')

    const input: TelemetryInput = { id, profile, sessionId, requestHash, ...intent,
      ...(intent.requestKind === 'user' && userInput !== undefined ? { userInput } : {}) }

    await Promise.race([record(input), new Promise<void>(resolve => setTimeout(resolve, 250))])
  } catch {
    // If an older desktop or a closed window has no recorder, optional userInput is omitted.
  }
}

/** Re-execution is a new user request; its reconstructed prompt is not a trustworthy display summary. */
export async function rememberRewindUsage(runtimeId: string, storedId: string | null | undefined, requestText: string): Promise<void> {
  if (!window.hermesDesktop?.rememberUsageInput) {return}

  try {
    const { $sessionStates } = await import('@/store/session-states')
    const { profileScopeForTranscriptSession, resolveActiveTranscriptSession } = await import('@/app/contrib/hooks/use-background-sync')
    const sessionId = storedId ?? $sessionStates.get()[runtimeId]?.storedSessionId

    if (!sessionId) {return}
    const scope = profileScopeForTranscriptSession(resolveActiveTranscriptSession(sessionId, runtimeId))

    if (scope && typeof scope === 'object' && scope.connectionId && scope.connectionId !== 'local') {return}
    const profile = scope && typeof scope === 'object' ? scope.profile : scope

    if (!profile) {return}
    await rememberUsageInput(crypto.randomUUID(), profile, sessionId, requestText)
  } catch {
    // The conversation still runs if this older session has no trustworthy route metadata.
  }
}
