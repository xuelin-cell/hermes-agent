import { atom } from 'nanostores'

import { isBrowserShell, isDeveloperMode } from '@/lib/browser-shell'
import { persistBoolean, storedBoolean } from '@/lib/storage'

const KEY = 'uniwork.desktop.developerMode.v1'

// Browser build: developer mode is the entry badge's (`isDeveloperMode()`, see
// lib/browser-shell), so everything gated on this store follows it there.
export const $developerMode = atom<boolean>(
  isBrowserShell() ? isDeveloperMode() : typeof window === 'undefined' ? false : storedBoolean(KEY, false)
)

export function setDeveloperMode(enabled: boolean): void {
  $developerMode.set(enabled)
}

export function toggleDeveloperMode(): boolean {
  // Browser build: only the badge toggles it (and reloads the page).
  if (isBrowserShell()) {
    return $developerMode.get()
  }

  const enabled = !$developerMode.get()
  setDeveloperMode(enabled)

  return enabled
}

if (typeof window !== 'undefined') {
  $developerMode.subscribe(enabled => persistBoolean(KEY, enabled))

  window.addEventListener('storage', event => {
    if (event.key === KEY && event.newValue !== null) {
      $developerMode.set(event.newValue === 'true')
    }
  })
}
