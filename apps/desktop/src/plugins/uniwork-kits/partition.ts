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
