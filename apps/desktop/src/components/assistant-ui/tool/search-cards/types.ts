/**
 * VR card types — structured cards extracted from search results.
 *
 * Backend (hexagent.tools.web.search) emits `Cards: [...]` JSON segment
 * alongside `Links: [...]`. Frontend parses + dispatches to category-specific
 * React components via the registry in index.ts.
 */

export interface VRCard {
  /** Tencent vr_category, e.g. "weather", "stock", "calendar", ... */
  type: string
  /** Raw item dict from Tencent (jsonData + display + other fields). */
  raw: Record<string, unknown>
}

export interface VRCardProps {
  card: VRCard
}
