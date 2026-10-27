// updater/release-notes.ts — authored "what's new" copy published beside the feed.
//
// A release feed carries a version and hashes: nothing a user can read. Notes
// live in one JSON object in the feed directory so the copy stays editable after
// the package is signed and uploaded — no rebuild, and no hand-editing of the
// yml electron-updater itself parses.
//
// Everything here is best-effort. A missing file, an unreadable document or a
// slow request leaves the overlay on its existing fallback and never fails an
// update check.

import { readFileSync } from 'node:fs'

import { load } from 'js-yaml'

import { channelPublicBase } from './channel-protocol'

export interface ReleaseNotesGroup {
  id: string
  label: string
  items: string[]
}

/** Grouped copy per locale. The renderer picks the locale — the main process
 *  does not know the UI language. */
export type ReleaseNotesByLocale = { [locale: string]: ReleaseNotesGroup[] }

export interface ReleaseNotesDoc {
  schema: 1
  notes: { [version: string]: ReleaseNotesByLocale }
}

export const RELEASE_NOTES_FILE = 'release-notes.json'
export const RELEASE_NOTES_TIMEOUT_MS = 3_000
export const RELEASE_NOTES_MAX_BYTES = 256 * 1024

const MAX_GROUPS = 8
const MAX_ITEMS = 20
const MAX_LABEL_CHARS = 40
const MAX_ITEM_CHARS = 300

function record(value: unknown): { [key: string]: unknown } | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as { [key: string]: unknown }) : null
}

function text(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed: string = value.trim()

  return trimmed.length > 0 && trimmed.length <= limit ? trimmed : null
}

function parseGroups(raw: unknown): ReleaseNotesGroup[] | null {
  if (!Array.isArray(raw)) {
    return null
  }

  const groups: ReleaseNotesGroup[] = []

  for (const entry of raw) {
    if (groups.length >= MAX_GROUPS) {
      break
    }

    const group = record(entry)
    const label = group ? text(group.label, MAX_LABEL_CHARS) : null

    if (!group || !label) {
      continue
    }

    const items: string[] = Array.isArray(group.items)
      ? group.items
          .map((item: unknown): string | null => text(item, MAX_ITEM_CHARS))
          .filter((item: string | null): item is string => Boolean(item))
          .slice(0, MAX_ITEMS)
      : []

    if (items.length === 0) {
      continue
    }

    groups.push({ id: text(group.id, 32) ?? label, label, items })
  }

  return groups.length > 0 ? groups : null
}

export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '')
}

/** Parse an authored notes document. Anything the overlay could not render is
 *  dropped rather than shown half-formed. */
export function parseReleaseNotes(raw: string): ReleaseNotesDoc | null {
  if (!raw || raw.length > RELEASE_NOTES_MAX_BYTES) {
    return null
  }

  let parsed: unknown

  try {
    parsed = load(raw)
  } catch {
    return null
  }

  const doc = record(parsed)

  if (!doc || doc.schema !== 1) {
    return null
  }

  const notes: { [version: string]: ReleaseNotesByLocale } = {}

  for (const [key, value] of Object.entries(record(doc.notes) ?? {})) {
    const version: string = normalizeVersion(key)
    const entry = record(value)
    const byLocale: ReleaseNotesByLocale = {}

    for (const [locale, groups] of Object.entries(entry ?? {})) {
      const parsedGroups = parseGroups(groups)

      if (parsedGroups) {
        byLocale[locale] = parsedGroups
      }
    }

    if (version && Object.keys(byLocale).length > 0) {
      notes[version] = byLocale
    }
  }

  return Object.keys(notes).length > 0 ? { schema: 1, notes } : null
}

/** The copy for one version, or null when the author has not written it yet. */
export function notesForVersion(doc: ReleaseNotesDoc | null, version: string): ReleaseNotesByLocale | null {
  return doc?.notes[normalizeVersion(version)] ?? null
}

/** A descriptor URL may name the yml itself; the notes live beside it. */
function feedDirectoryUrl(descriptorUrl: string): string | null {
  try {
    const url = new URL(descriptorUrl)
    const directory = /\.[a-z0-9]+$/i.test(url.pathname) ? new URL('./', url) : url

    return channelPublicBase(directory.href)
  } catch {
    return null
  }
}

/**
 * Where the notes live: the same directory the feed descriptor is read from.
 * config.yaml's override wins (it names the feed base, so the directory is
 * appended); otherwise the baked descriptor already points at the directory.
 * Null means this install has no feed to read notes from.
 */
export function resolveReleaseNotesUrl(input: {
  configuredBase: string
  feedDirectory: string
  descriptorUrl?: string | null
}): string | null {
  let directory: string | null = null

  if (input.configuredBase.trim()) {
    try {
      directory = `${channelPublicBase(input.configuredBase.trim())}/${input.feedDirectory}`
    } catch {
      directory = null
    }
  } else if (input.descriptorUrl) {
    directory = feedDirectoryUrl(input.descriptorUrl)
  }

  return directory ? `${directory}/${RELEASE_NOTES_FILE}` : null
}

/** The `url:` of the generic descriptor electron-updater itself reads. */
export function readBakedFeedUrl(appUpdatePath: string | null | undefined): string | null {
  if (!appUpdatePath) {
    return null
  }

  try {
    const url: unknown = record(load(readFileSync(appUpdatePath, 'utf8')))?.url

    return typeof url === 'string' && url.trim() ? url.trim() : null
  } catch {
    return null
  }
}

export interface ReleaseNotesFetchOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Read the notes for `version`. Never throws and never blocks the update
 * decision: every failure path resolves null and only logs.
 */
export async function fetchReleaseNotes(
  url: string,
  version: string,
  log: (message: string) => void = () => {},
  options: ReleaseNotesFetchOptions = {}
): Promise<ReleaseNotesByLocale | null> {
  const request: typeof fetch = options.fetchImpl ?? fetch

  try {
    const response: Response = await request(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? RELEASE_NOTES_TIMEOUT_MS)
    })

    if (response.status !== 200) {
      log(`Release notes: ${response.status} from ${url}`)

      return null
    }

    const declared: number = Number(response.headers.get('content-length') ?? '')

    if (Number.isFinite(declared) && declared > RELEASE_NOTES_MAX_BYTES) {
      log(`Release notes: descriptor too large at ${url}`)

      return null
    }

    const body: string = await response.text()

    if (body.length > RELEASE_NOTES_MAX_BYTES) {
      log(`Release notes: descriptor too large at ${url}`)

      return null
    }

    const notes = notesForVersion(parseReleaseNotes(body), version)

    if (!notes) {
      log(`Release notes: no copy for version ${normalizeVersion(version)}`)
    }

    return notes
  } catch (error) {
    log(`Release notes: ${error instanceof Error ? error.message : String(error)}`)

    return null
  }
}
