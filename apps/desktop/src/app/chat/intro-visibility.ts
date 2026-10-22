/**
 * Whether the empty-chat intro splash renders.
 *
 * Fresh drafts and ready empty sessions share the welcome state, including
 * sessions created in tabs and split panes. A loading historical transcript
 * must never look like a new conversation.
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
  loading?: boolean
  hasHistory?: boolean
  running?: boolean
}): boolean {
  const readyDraft =
    input.primary &&
    input.freshDraftReady &&
    !input.activeSessionId &&
    !input.selectedSessionId &&
    !input.routedSessionView

  return (
    input.enabled &&
    !input.auxiliaryWindow &&
    (readyDraft || Boolean(input.activeSessionId)) &&
    !input.quietDraft &&
    !input.loading &&
    !input.hasHistory &&
    !input.running &&
    input.messagesEmpty
  )
}
