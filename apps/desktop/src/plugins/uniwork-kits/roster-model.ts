export interface InstalledExpert {
  displayName: string
  profile: string
}

export interface RosterProfile {
  display_name?: string
  name?: string
  title?: string
  ui_meta?: {
    'hermes-bots'?: {
      created?: number
      title?: string
    }
  }
}

interface RosterCache {
  profiles?: RosterProfile[]
}

/** 从套件页目录里挑出已装的专家（不含专家档案里自己的那条），给机器人名单用。 */
export function installedExperts(
  rows: Array<{ display_name?: string; kind?: string; profile?: string; self?: boolean }>
): InstalledExpert[] {
  const experts: InstalledExpert[] = []

  for (const row of rows) {
    const profile = String(row.profile || '').trim()

    if (row.kind !== 'expert' || row.self || !profile) {
      continue
    }

    experts.push({
      displayName: String(row.display_name || '').trim() || profile,
      profile
    })
  }

  return experts
}

/** 把机器人名单快照里还没有的专家追加进去；全都在时原样返回，不触发重绘。 */
export function withInstalledExperts<T extends RosterCache>(
  snapshot: T | undefined,
  experts: InstalledExpert[]
): T | undefined {
  if (!snapshot || !Array.isArray(snapshot.profiles)) {
    return snapshot
  }

  const present = new Set(snapshot.profiles.map(row => String(row?.name || '').trim()).filter(Boolean))
  const missing = experts.filter(expert => expert.profile && !present.has(expert.profile))

  if (missing.length === 0) {
    return snapshot
  }

  const now = Date.now()

  return {
    ...snapshot,
    profiles: [
      ...snapshot.profiles,
      ...missing.map(expert => ({
        display_name: expert.displayName,
        name: expert.profile,
        title: expert.displayName,
        ui_meta: {
          'hermes-bots': {
            created: now,
            title: expert.displayName
          }
        }
      }))
    ]
  }
}
