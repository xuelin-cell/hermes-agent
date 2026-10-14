// Zoom for the PDF viewer (pdf-preview.tsx, pdf-engine.ts). A scale is pdf.js's:
// 1 shows a page at its printed size (96 px to the inch).

// The steps of the zoom buttons and of a mouse wheel notch, like a browser's.
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 5

// As wide as the page viewer shows a page (office-slides.tsx): a document no
// wider than paper on a desk, a wide page (a slide) wider.
const PAGE_MAX_PX = 768
const WIDE_PAGE_MAX_PX = 1024

/** The next zoom step up (1) or down (-1) from `scale`. */
export function stepZoom(scale: number, direction: -1 | 1): number {
  if (direction > 0) {
    return ZOOM_STEPS.find(step => step > scale * 1.01) ?? MAX_ZOOM
  }

  return ZOOM_STEPS.findLast(step => step < scale * 0.99) ?? MIN_ZOOM
}

export function clampZoom(scale: number): number {
  return Math.min(Math.max(scale, MIN_ZOOM), MAX_ZOOM)
}

/** The scale that fits a page `width` × `height` (px at scale 1) into `room` px:
 * as wide as the room, at most as wide as the page viewer shows a page. Null
 * while there is no room to fit into (a hidden pane). */
export function fitScale(width: number, height: number, room: number): null | number {
  if (width <= 0 || room <= 0) {
    return null
  }

  return Math.min(room, width > height ? WIDE_PAGE_MAX_PX : PAGE_MAX_PX) / width
}
