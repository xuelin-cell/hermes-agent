import { capabilityScoped, type ProfileScope } from '@/api/client'
import { requestComposerInsert } from '@/app/chat/composer/focus'
import { newSessionInAgent } from '@/store/profile'

/** Explicit example click creates a scoped draft, never auto-sends a potentially destructive action. */
export function openConnectorExample(scope: ProfileScope, text: string): void {
  const { profile = 'default' } = capabilityScoped(scope)
  newSessionInAgent({ connectionId: 'local', profile })
  requestComposerInsert(text, { target: 'main' })
}
