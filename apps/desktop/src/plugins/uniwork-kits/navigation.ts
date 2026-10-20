/** Hash the kits page is mounted on. The desktop router is hash-based. */
export const KITS_HASH = '#/kits'

/** 跳到套件页；已经在套件页时什么都不做。 */
export function openKitsPage(): void {
  if (window.location.hash === KITS_HASH) {
    return
  }

  window.location.hash = KITS_HASH
}
