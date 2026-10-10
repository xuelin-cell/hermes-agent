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
const MIN_ZOOM_PERCENT = 50
const MAX_ZOOM_PERCENT = 200

function normalizedZoomPercent(value: unknown): number {
  if (value === null || value === undefined || value === '') {
    return DEFAULT_ZOOM_PERCENT
  }

  const percent = Number(value)

  return Number.isFinite(percent)
    ? Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, Math.round(percent)))
    : DEFAULT_ZOOM_PERCENT
}

function storedBrowserZoomPercent(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_ZOOM_PERCENT
  }

  try {
    return normalizedZoomPercent(window.localStorage.getItem(BROWSER_ZOOM_STORAGE_KEY))
  } catch {
    return DEFAULT_ZOOM_PERCENT
  }
}

function applyBrowserZoom(percent: number): void {
  document.documentElement.style.zoom = `${percent}%`
}

const desktopZoom = typeof window === 'undefined' ? undefined : window.hermesDesktop?.zoom
const initialZoomPercent = desktopZoom ? DEFAULT_ZOOM_PERCENT : storedBrowserZoomPercent()

export const $zoomPercent = atom<number>(initialZoomPercent)

export function setZoomPercent(percent: number): void {
  const normalized = normalizedZoomPercent(percent)

  if (desktopZoom) {
    desktopZoom.setPercent(normalized)

    return
  }

  applyBrowserZoom(normalized)
  $zoomPercent.set(normalized)

  try {
    window.localStorage.setItem(BROWSER_ZOOM_STORAGE_KEY, String(normalized))
  } catch {
    // Storage may be unavailable in a locked-down browser. The active page
    // can still apply and retain the selected zoom until it is reloaded.
  }
}

if (desktopZoom) {
  void desktopZoom.get().then(({ percent }) => $zoomPercent.set(percent))
  desktopZoom.onChanged(({ percent }) => $zoomPercent.set(percent))
} else if (typeof document !== 'undefined') {
  applyBrowserZoom(initialZoomPercent)
}
