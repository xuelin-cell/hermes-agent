import { registry } from '@/contrib/registry'
import { $activeGatewayProfile, $newChatProfile } from '@/store/profile'

/** Managed profiles can return generic New Session actions to their parent assistant. */
export const NEW_SESSION_DEFAULT_AREA = 'session.new-default'

export interface NewSessionDefaultContribution {
  profiles: readonly string[]
  targetProfile: string
  /** Retire transient draft state before leaving the managed profile. */
  prepare: () => void
}

export function contributedNewSessionDefault(): NewSessionDefaultContribution | undefined {
  const profile = $newChatProfile.get() || $activeGatewayProfile.get()

  return registry
    .getArea(NEW_SESSION_DEFAULT_AREA)
    .map(contribution => contribution.data as NewSessionDefaultContribution)
    .find(contribution => contribution.profiles.includes(profile))
}
