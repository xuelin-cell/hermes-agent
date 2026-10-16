import { queryClient } from '@hermes/plugin-sdk'

import { type InstalledExpert, withInstalledExperts } from './roster-model'

/** Prefix of Bot Mode's roster query. The live key appends the connection id. */
export const ROSTER_QUERY_KEY = ['hermes-bots', 'roster'] as const

interface RosterCache {
  profiles?: Array<{ name?: string }>
}

/** Paint newly installed experts on the Bots list, then let profiles.list replace the row. */
export async function publishInstalledExperts(experts: InstalledExpert[]): Promise<void> {
  await queryClient.cancelQueries({ queryKey: [...ROSTER_QUERY_KEY] })
  queryClient.setQueriesData<RosterCache>({ queryKey: [...ROSTER_QUERY_KEY] }, current =>
    withInstalledExperts(current, experts)
  )
  await queryClient.invalidateQueries({ queryKey: [...ROSTER_QUERY_KEY] })
}
