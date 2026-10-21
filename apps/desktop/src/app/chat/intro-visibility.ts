/**
 * Whether the empty-chat intro splash renders.
 *
 * The splash is the full-height empty state of the primary chat: it belongs to
 * a fresh draft in the main window and nothing else. Auxiliary and non-primary
 * windows are scratch surfaces, a routed or active session already owns the
 * view, and any transcript at all means the conversation started.
 *
 * `enabled` is the user's Appearance toggle and outranks every other clause:
 * turning the splash off never depends on which window asks.
 * `quietDraft` hides it on a draft a caller opened with `quiet`: that caller
 * draws its own empty state, including the seconds before the profile's
 * backend finishes starting.
 */
export function shouldShowIntro(input: {
  activeSessionId: null | string
  auxiliaryWindow: boolean
  enabled: boolean
  freshDraftReady: boolean
  messagesEmpty: boolean
  primary: boolean
  quietDraft?: boolean
  routedSessionView: boolean
  selectedSessionId: null | string
}): boolean {
  return (
    input.enabled &&
    input.primary &&
    !input.auxiliaryWindow &&
    input.freshDraftReady &&
    !input.quietDraft &&
    !input.routedSessionView &&
    !input.selectedSessionId &&
    !input.activeSessionId &&
    input.messagesEmpty
  )
}
