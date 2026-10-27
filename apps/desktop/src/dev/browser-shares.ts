import type { ArtifactShareRecord, ArtifactSharePublishInput, ArtifactShareSource } from '@hermes/shared/artifact-share'
import type { ConversationShareApi } from '@hermes/shared/conversation-share'

import { requestEntryMaas } from '../../../shared/src/browser-maas-auth.js'

/** The renderer retains the desktop contracts; only the trusted transport changes. */
export function browserShares(base: string) {
  const listeners = new Set<(key: string) => void>()
  const call = <T>(kind: 'conversation' | 'artifact', operation: string, body: unknown) =>
    requestEntryMaas<T>(base, `${kind}-shares/${operation}`, {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`hermes-shares:${base}`) : null
  const changed = (key: string) => { for (const listener of listeners) listener(key) }
  if (channel) channel.onmessage = event => { if (typeof event.data === 'string') changed(event.data) }
  const mutation = async <T>(operation: string, body: unknown, key: string): Promise<T> => {
    const result = await call<T>('artifact', operation, body)
    changed(key)
    channel?.postMessage(key)
    return result
  }
  const conversationShare: ConversationShareApi = {
    prepare: (owner, request) => call('conversation', 'prepare', { owner, request }),
    image: (ticket, reference) => call('conversation', 'image', { ticket, reference }),
    publish: (ticket, html) => call('conversation', 'publish', { ticket, html }),
    cancel: ticket => call('conversation', 'cancel', { ticket }),
    list: (owner, sessionId) => call('conversation', 'list', { owner, sessionId }),
    revoke: key => call('conversation', 'revoke', { key })
  }
  let timer: ReturnType<typeof setInterval> | undefined
  let polling = false
  let revision: number | null = null
  // Instance hooks run outside the browser; poll one lightweight revision only while a share UI watches.
  const poll = async () => {
    if (polling || !listeners.size) return
    polling = true
    try {
      const result = await call<{ revision: number }>('artifact', 'revision', {})
      const updated = result.revision !== revision
      revision = result.revision
      if (updated) changed('*')
    } catch {
      // The visible share operation owns errors; this observer only retries while mounted.
    } finally { polling = false }
  }
  const artifactShare: Window['hermesDesktop']['artifactShare'] = {
    inspect: query => call<ArtifactShareRecord | null>('artifact', 'inspect', { query }),
    eligibility: (source: ArtifactShareSource) => call('artifact', 'eligibility', { source }),
    markUploaded: sessionId => mutation('mark-uploaded', { sessionId }, '*'),
    publish: (input: ArtifactSharePublishInput) => mutation('publish', input, input.key),
    setExpiration: (key, shareId, ttlDays) => mutation('expiration', { key, shareId, ttlDays }, key),
    revoke: (key, shareId) => mutation('revoke', { key, shareId }, key),
    onChanged: callback => {
      listeners.add(callback)
      if (!timer) { void poll(); timer = setInterval(() => void poll(), 3000) }
      return () => {
        listeners.delete(callback)
        if (!listeners.size) { clearInterval(timer); timer = undefined }
      }
    }
  }
  return { conversationShare, artifactShare }
}
