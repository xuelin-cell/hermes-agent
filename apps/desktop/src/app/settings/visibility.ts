const DEVELOPER_SETTINGS = new Set<string>([
  'config:model',
  'config:advanced',
  'config:browser',
  'vault',
  'gateway',
  'connections',
  'billing'
])

/** 根据开发者模式统一决定设置入口是否可见。 */
export function settingsViewVisible(view: string, developerMode: boolean): boolean {
  return developerMode || !DEVELOPER_SETTINGS.has(view)
}
