import { atom } from '@hermes/plugin-sdk'

import { fetchExpertAvatar, fetchExperts } from './api'
import type { ExpertDirectory } from './types'

/** Installed experts and the recently summoned, as the backend lists them. */
export const $expertDirectory = atom<ExpertDirectory>({ experts: [], recent: [] })

/** Expert name → avatar data URL; `''` while loading or when there is none. */
export const $expertAvatars = atom<Record<string, string>>({})

let inflight: null | Promise<void> = null
const loadingAvatars = new Set<string>()

/** 从后端取召唤名单放进 $expertDirectory；同时只发一个请求，失败时保留原来的名单。 */
export function loadExperts(): Promise<void> {
  inflight ??= fetchExperts()
    .then(directory => {
      // An explicit refresh/install can repair a failed or previously missing portrait.
      const avatars = $expertAvatars.get()
      const retained = Object.fromEntries(Object.entries(avatars).filter(([name, image]) => image || loadingAvatars.has(name)))
      if (Object.keys(retained).length !== Object.keys(avatars).length) { $expertAvatars.set(retained) }
      $expertDirectory.set({ experts: directory.experts ?? [], recent: directory.recent ?? [] })
    })
    .catch(() => undefined)
    .finally(() => {
      inflight = null
    })

  return inflight
}

/** 按需取一位专家的头像，每位只取一次；取不到时记为空，避免反复请求。 */
export function loadAvatar(name: string): void {
  if (!name || name in $expertAvatars.get() || loadingAvatars.has(name)) {
    return
  }

  loadingAvatars.add(name)
  $expertAvatars.set({ ...$expertAvatars.get(), [name]: '' })
  void fetchExpertAvatar(name)
    .then(found => $expertAvatars.set({ ...$expertAvatars.get(), [name]: found.data_url || '' }))
    .catch(() => undefined)
    .finally(() => loadingAvatars.delete(name))
}
