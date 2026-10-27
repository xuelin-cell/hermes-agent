/** 套件的统一入口：扩展 → 专家 → 套件。 */
export const KITS_PATH = '/capabilities?tab=experts&shelf=kits'
export const KITS_HASH = '#' + KITS_PATH

/** 打开扩展里的套件分栏，已经打开时不重复导航。 */
export function openKitsPage(): void {
  if (window.location.hash === KITS_HASH) {
    return
  }

  window.location.hash = KITS_HASH
}
