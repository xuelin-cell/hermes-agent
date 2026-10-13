/** Hash the kits page is mounted on. The desktop router is hash-based. */
export const KITS_HASH = '#/kits'

export function openKitsPage(): void {
  if (window.location.hash === KITS_HASH) {
    return
  }

  window.location.hash = KITS_HASH
}
