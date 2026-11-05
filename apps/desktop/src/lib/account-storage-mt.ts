// desktop-mt: one browser, several accounts (unified login switches accounts in place). What the app keeps in
// localStorage — the last session, drafts, open tabs, pinned chats, preferences — belongs to the account it
// was written under, and must not show up for the next one. When the signed-in account changes, the previous
// account's keys are put away as one entry and the new account's are brought back. Keys that are not about an
// account (themes, the bookkeeping here, the browser login the bridge rewrites) stay where they are.
// Data from before this existed is left to the first account seen: most likely it is that person's.

const CURRENT = 'hermes.mt.account.v1'
const ARCHIVE = 'hermes.mt.account-archive.v1:'

function shared(key: string): boolean {
  return key === CURRENT || key.startsWith(ARCHIVE) || key.startsWith('hermes.cloud.auth.v1:') || /theme/i.test(key)
}

/** Puts the previous account's keys away and brings this account's back. Safe to call on every start. */
export function scopeStorageToAccount(account: string, storage: Storage = window.localStorage): void {
  if (!account) {
    return
  }

  let previous: null | string

  try {
    previous = storage.getItem(CURRENT)
  } catch {
    return // storage is blocked: nothing to keep apart
  }

  if (previous === account) {
    return
  }

  const snapshot: Record<string, string> = {}

  if (previous) {
    const keys: string[] = []

    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)

      if (key && !shared(key)) {
        keys.push(key)
      }
    }

    for (const key of keys) {
      const value = storage.getItem(key)

      if (value !== null) {
        snapshot[key] = value
      }
    }

    for (const key of keys) {
      storage.removeItem(key)
    }
  }

  // Who the keys belong to is written before anything else: were it left stale, the next start would file
  // this account's state under the previous one.
  try {
    storage.setItem(CURRENT, account)
  } catch {
    try {
      storage.removeItem(CURRENT)
    } catch {
      // nothing more to do
    }

    return
  }

  if (previous && Object.keys(snapshot).length > 0) {
    try {
      storage.setItem(ARCHIVE + previous, JSON.stringify(snapshot))
    } catch {
      // Full: the previous account loses its local state rather than handing it to the next one.
    }
  }

  const saved = storage.getItem(ARCHIVE + account)

  if (saved) {
    storage.removeItem(ARCHIVE + account)

    try {
      for (const [key, value] of Object.entries(JSON.parse(saved) as Record<string, unknown>)) {
        if (typeof value === 'string' && !shared(key)) {
          storage.setItem(key, value)
        }
      }
    } catch {
      // A broken archive, or one that no longer fits, starts this account (partly) afresh.
    }
  }
}
