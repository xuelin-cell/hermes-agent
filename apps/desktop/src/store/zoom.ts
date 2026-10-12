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

const desktopZoom = typeof window === 'undefined' ? undefined : window.hermesDesktop?.zoom

export const $zoomPercent = atom<number>(DEFAULT_ZOOM_PERCENT)

/** 缩放设置只交给原生主进程应用，页面等待变更事件同步数值。 */
export function setZoomPercent(percent: number): void {
  desktopZoom?.setPercent(percent)
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
}
