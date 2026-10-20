/**
 * The bundled kits and experts going into a new account (or an updated app).
 *
 * The backend installs them on its own when it starts (plugins/uniwork-kits
 * autoseed); the first time takes about twenty seconds. This watches that run
 * so the kits page and the summon picker can say "being prepared" instead of
 * "nothing installed", and refreshes the expert list and the Bots roster once
 * it is done.
 */

import { atom } from '@hermes/plugin-sdk'

import { fetchBundled, fetchCatalog } from './api'
import { loadExperts } from './experts-store'
import { publishInstalledExperts } from './roster'
import { installedExperts } from './roster-model'
import type { BundledStatus } from './types'

const POLL_MS = 2000

const IDLE: BundledStatus = {
  ran: false,
  running: false,
  name: '',
  done: 0,
  total: 0,
  installed: 0,
  unchanged: 0,
  failed: [],
  error: ''
}

export const $bundled = atom<BundledStatus>(IDLE)

/** Bumped each time an install this window watched has finished. */
export const $bundledFinished = atom(0)

let watching = false

/** 后端还在安装内置包时每 2 秒查一次进度；装完后刷新专家名单和机器人名单。同一时间只跑一个轮询。 */
export async function watchBundled(): Promise<void> {
  if (watching) {
    return
  }

  watching = true
  let sawRun = false

  try {
    for (;;) {
      const status = await fetchBundled().catch(() => null)

      if (!status) {
        return
      }

      $bundled.set(status)
      sawRun ||= status.running

      if (!status.running) {
        break
      }

      await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }

    if (sawRun) {
      $bundledFinished.set($bundledFinished.get() + 1)
      await loadExperts()
      const catalog = await fetchCatalog().catch(() => null)

      if (catalog) {
        await publishInstalledExperts(installedExperts(catalog.plugins))
      }
    }
  } finally {
    watching = false
  }
}
