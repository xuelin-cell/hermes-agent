import type { KitRow } from './types'

export interface KitShelves {
  experts: KitRow[]
  kits: KitRow[]
}

/** 补齐旧版后端目录里缺的字段，页面对新旧后端都能正常显示。 */
export function normalizeRow(row: KitRow): KitRow {
  return {
    ...row,
    description: row.description ?? '',
    missing_secrets: row.missing_secrets ?? [],
    oauth_servers: row.oauth_servers ?? [],
    phrases: row.phrases ?? [],
    profession: row.profession ?? '',
    user_config: row.user_config ?? []
  }
}

/** 把默认档案的条目分到两个书架：专家条目放专家书架，其余都是套件。 */
export function partition(rows: KitRow[]): KitShelves {
  const kits: KitRow[] = []
  const experts: KitRow[] = []

  for (const row of rows) {
    if (row.kind === 'expert' && !row.self) {
      experts.push(row)
    } else {
      kits.push(row)
    }
  }

  return { kits, experts }
}

/** 搜索时判断一张卡片是否命中：输入的每个词都要出现在名字、简介或触发词里。 */
export function matchesQuery(row: KitRow, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)

  if (words.length === 0) {
    return true
  }

  const haystack = [row.name, row.display_name, row.profession, row.description, ...(row.phrases ?? [])]
    .join('\n')
    .toLowerCase()

  return words.every(word => haystack.includes(word))
}
