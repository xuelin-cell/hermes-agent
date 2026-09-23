import { atom } from 'nanostores'

import { persistBoolean, storedBoolean } from '@/lib/storage'

const KEY = 'uniwork.desktop.developerMode.v1'

export const $developerMode = atom<boolean>(typeof window === 'undefined' ? false : storedBoolean(KEY, false))

export function setDeveloperMode(enabled: boolean): void {
  $developerMode.set(enabled)
}

export function toggleDeveloperMode(): boolean {
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
