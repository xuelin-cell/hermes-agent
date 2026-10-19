import { atom } from '@hermes/plugin-sdk'

import { fetchExpertAvatar, fetchExperts } from './api'
import type { ExpertDirectory } from './types'

/** Installed experts and the recently summoned, as the backend lists them. */
export const $expertDirectory = atom<ExpertDirectory>({ experts: [], recent: [] })

/** Expert name → avatar data URL; `''` while loading or when there is none. */
export const $expertAvatars = atom<Record<string, string>>({})

let inflight: null | Promise<void> = null

export function loadExperts(): Promise<void> {
  inflight ??= fetchExperts()
    .then(directory => {
      $expertDirectory.set({ experts: directory.experts ?? [], recent: directory.recent ?? [] })
    })
    .catch(() => undefined)
    .finally(() => {
      inflight = null
    })

  return inflight
}

export function loadAvatar(name: string): void {
  if (!name || name in $expertAvatars.get()) {
    return
  }

  $expertAvatars.set({ ...$expertAvatars.get(), [name]: '' })
  void fetchExpertAvatar(name)
    .then(found => $expertAvatars.set({ ...$expertAvatars.get(), [name]: found.data_url || '' }))
    .catch(() => undefined)
}
