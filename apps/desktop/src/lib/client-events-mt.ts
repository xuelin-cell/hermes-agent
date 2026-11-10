// desktop-mt: what the cloud page tells the entry about itself, so "the page restarted by itself", "it switched
// me back to the enterprise account" and "it took ten seconds" can be traced to a cause in the entry's log
// (deploy/hermes-mt/entry/entry/client_events.py writes one line per event):
// - reload: every reload or redirect the page starts on its own says why first (reloadFor / replaceFor);
// - boot: once the instance link first opens, how long start-up took and where, and why the last page went
//   away — a reload nobody recorded is the user's own (F5);
// - link: the link to the instance dropped for longer than a blip, and how long it stayed down.
// Nothing is sent until installClientEvents runs (the browser build only); the desktop app just reloads.

export type ClientFields = Record<string, boolean | number | string | undefined>

const LAST_EXIT_KEY = 'hermes.mt.lastExit'
const BOOT_GIVE_UP_MS = 120_000
// Switching to an expert swaps the active link for a moment; only a longer drop is worth a line.
const LINK_BLIP_MS = 3_000

interface LastExit {
  at: number
  reason: string
}

let endpoint: null | string = null
let previousExit: LastExit | null = null
let bootReported = false
const marks: Record<string, number> = {}
let linkOpen = false
let droppedAt: null | number = null
let dropReported = false
let dropTimer: ReturnType<typeof setTimeout> | undefined

function elapsed(): number {
  return Math.round(performance.now())
}

function compact(fields: ClientFields): Record<string, boolean | number | string> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Record<
    string,
    boolean | number | string
  >
}

/** Fire and forget: a beacon survives the reload that follows it. */
export function reportClientEvent(type: 'boot' | 'link' | 'reload', fields: ClientFields = {}): void {
  if (!endpoint) {
    return
  }

  const body = JSON.stringify({ type, ...compact(fields) })

  try {
    if (navigator.sendBeacon?.(endpoint, new Blob([body], { type: 'application/json' }))) {
      return
    }
  } catch {
    // fall through to fetch
  }

  void fetch(endpoint, {
    body,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    method: 'POST'
  }).catch(() => undefined)
}

function lastMark(): string {
  const names = Object.keys(marks)

  return names.length ? names[names.length - 1] : 'none'
}

function noteExit(reason: string, detail: ClientFields): void {
  try {
    sessionStorage.setItem(LAST_EXIT_KEY, JSON.stringify({ at: Date.now(), reason } satisfies LastExit))
  } catch {
    // private mode: the boot report just lacks the reason
  }

  reportClientEvent('reload', {
    reason,
    ...detail,
    page_s: Math.round(elapsed() / 1000),
    visible: document.visibilityState === 'visible',
    booted: bootReported ? true : lastMark()
  })
}

/** Reloads the page, telling the entry why first. */
export function reloadFor(reason: string, detail: ClientFields = {}): void {
  noteExit(reason, detail)
  window.location.reload()
}

/** Leaves for another address (the login page), telling the entry why first. */
export function replaceFor(reason: string, url: string, detail: ClientFields = {}): void {
  noteExit(reason, detail)
  window.location.replace(url)
}

/** A start-up step finished; the first time each step is reached counts. */
export function markBoot(step: string): void {
  marks[step] ??= elapsed()
}

function reportBoot(outcome: 'open' | 'stuck'): void {
  if (bootReported || !endpoint) {
    return
  }

  bootReported = true
  const navigation = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined

  reportClientEvent('boot', {
    outcome,
    ms: elapsed(),
    ...Object.fromEntries(Object.entries(marks).map(([step, at]) => [`at_${step}`, at])),
    dom: navigation ? Math.round(navigation.domContentLoadedEventEnd) : undefined,
    nav: navigation?.type,
    last_step: outcome === 'stuck' ? lastMark() : undefined,
    prev: previousExit?.reason ?? (navigation?.type === 'reload' ? 'user-reload' : undefined),
    prev_s: previousExit ? Math.round((Date.now() - previousExit.at) / 1000) : undefined
  })
}

/** The active instance link changed state (store/session's $gatewayState). */
export function noteLinkState(state: string): void {
  if (state === 'open') {
    clearTimeout(dropTimer)
    markBoot('link')
    reportBoot('open')

    if (dropReported && droppedAt !== null) {
      reportClientEvent('link', { state: 'restored', down_s: Math.round((elapsed() - droppedAt) / 1000) })
    }

    linkOpen = true
    droppedAt = null
    dropReported = false

    return
  }

  if (!linkOpen || droppedAt !== null || (state !== 'closed' && state !== 'error' && state !== 'connecting')) {
    return
  }

  droppedAt = elapsed()
  dropTimer = setTimeout(() => {
    dropReported = true
    reportClientEvent('link', { state, visible: document.visibilityState === 'visible' })
  }, LINK_BLIP_MS)
}

/** Browser build only: starts reporting to the entry under `apiBase`. */
export function installClientEvents(apiBase: string): void {
  endpoint = `${apiBase}__entry/client-event`

  try {
    previousExit = JSON.parse(sessionStorage.getItem(LAST_EXIT_KEY) ?? 'null') as LastExit | null
    sessionStorage.removeItem(LAST_EXIT_KEY)
  } catch {
    previousExit = null
  }

  markBoot('script')
  setTimeout(() => reportBoot('stuck'), BOOT_GIVE_UP_MS)
}

/** Tests only. */
export function resetClientEventsForTests(): void {
  endpoint = null
  previousExit = null
  bootReported = false
  linkOpen = false
  droppedAt = null
  dropReported = false
  clearTimeout(dropTimer)

  for (const step of Object.keys(marks)) {
    delete marks[step]
  }
}
