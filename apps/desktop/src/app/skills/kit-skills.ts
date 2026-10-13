/** A kit skill is named `套件--技能`. Those rows are managed on the Kits page. */
export function isManagedKitSkill(name: string): boolean {
  return name.includes('--')
}
