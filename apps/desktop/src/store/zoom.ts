/**
 * Window text size (zoom).
 *
 * The main process owns the zoom level and persists it (see electron/zoom.ts
 * for the scale). The renderer only mirrors the current percent for the
 * settings UI: preset clicks go to the main process over IPC, and every
 * change comes back through onChanged, including ones made with the
 * Ctrl/Cmd +/-/0 shortcuts or the View menu, so the UI never drifts.
 */

import { atom } from 'nanostores'

// Mirror DEFAULT_ZOOM_LEVEL (90%) so Appearance doesn't flash 100% before
// the main-process zoom.get() resolves. Keep in sync with electron/zoom.ts.
const DEFAULT_ZOOM_PERCENT = 90
const BROWSER_ZOOM_STORAGE_KEY = 'uniwork.browser.zoomPercent.v1'

const desktopZoom = typeof window === 'undefined' ? undefined : window.hermesDesktop?.zoom

function storedBrowserZoomPercent(): number {
  if (typeof window === 'undefined') {return DEFAULT_ZOOM_PERCENT}

  const stored = Number(window.localStorage.getItem(BROWSER_ZOOM_STORAGE_KEY))

  return Number.isFinite(stored) && stored >= 50 && stored <= 200 ? stored : DEFAULT_ZOOM_PERCENT
}

const initialZoomPercent = desktopZoom ? DEFAULT_ZOOM_PERCENT : storedBrowserZoomPercent()

export const $zoomPercent = atom<number>(initialZoomPercent)

export function setZoomPercent(percent: number): void {
  if (desktopZoom) {
    desktopZoom.setPercent(percent)

    return
  }

  document.documentElement.style.zoom = `${percent}%`
  window.localStorage.setItem(BROWSER_ZOOM_STORAGE_KEY, String(percent))
  $zoomPercent.set(percent)
}

if (desktopZoom) {
  let receivedZoomChange = false

  desktopZoom.onChanged(({ percent }) => {
    receivedZoomChange = true
    $zoomPercent.set(percent)
  })

  void desktopZoom.get().then(({ percent }) => {
    if (!receivedZoomChange) {
      $zoomPercent.set(percent)
    }
  })
} else if (typeof document !== 'undefined') {
  document.documentElement.style.zoom = `${initialZoomPercent}%`
}
