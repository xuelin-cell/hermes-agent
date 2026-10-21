import { queryClient } from '@hermes/plugin-sdk'

import { type InstalledExpert, withInstalledExperts } from './roster-model'

/** Prefix of Bot Mode's roster query. The live key appends the connection id. */
export const ROSTER_QUERY_KEY = ['hermes-bots', 'roster'] as const

interface RosterCache {
  profiles?: Array<{ name?: string }>
}

/** 新装的专家先画到机器人名单上，之后由 profiles.list 的正式结果替换这一行。 */
export async function publishInstalledExperts(experts: InstalledExpert[]): Promise<void> {
  await queryClient.cancelQueries({ queryKey: [...ROSTER_QUERY_KEY] })
  queryClient.setQueriesData<RosterCache>({ queryKey: [...ROSTER_QUERY_KEY] }, current =>
    withInstalledExperts(current, experts)
  )
  await queryClient.invalidateQueries({ queryKey: [...ROSTER_QUERY_KEY] })
}
