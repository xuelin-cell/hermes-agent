import type { KitRow } from './types'

export interface KitShelves {
  experts: KitRow[]
  kits: KitRow[]
}

/** Parent-profile rows: expert stubs go on the expert shelf; everything else is a kit. */
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

/** Whether *row* matches a search: every word must appear in its name, description or phrases. */
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
