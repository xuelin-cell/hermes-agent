/**
 * Locale selection for authored release notes.
 *
 * The publisher writes one note set per version and per locale, but almost
 * never every locale the app ships. Prefer the reader's locale, then the
 * product's primary Chinese copy, then English, then whatever the author did
 * publish — never show an empty list when copy exists.
 */

import type { DesktopReleaseNotesByLocale } from '@/global'

/** One rendered changelog group: authored notes and commit groups share it. */
export interface ReleaseNoteGroup {
  id: string
  label: string
  items: string[]
}

export function selectReleaseNotes(
  notes: DesktopReleaseNotesByLocale | null | undefined,
  locale: string
): ReleaseNoteGroup[] | null {
  if (!notes) {
    return null
  }

  for (const candidate of [locale, locale.split('-')[0], 'zh', 'en']) {
    const groups = notes[candidate]

    if (groups && groups.length > 0) {
      return groups
    }
  }

  for (const groups of Object.values(notes)) {
    if (groups.length > 0) {
      return groups
    }
  }

  return null
}
