const DEVELOPER_SETTINGS = new Set<string>([
  'config:model',
  'config:advanced',
  'config:browser',
  'config:memory',
  'vault',
  'gateway',
  'connections',
  'billing'
])

/** 根据开发者模式统一决定设置入口是否可见。 */
export function settingsViewVisible(view: string, developerMode: boolean): boolean {
  return developerMode || !DEVELOPER_SETTINGS.has(view)
}

/** 按设置分组与字段控制开发者专属字段，避免搜索结果泄露隐藏项。 */
export function settingsFieldVisible(view: string, field: string, developerMode: boolean): boolean {
  return developerMode || !(view === 'config:chat' && field === 'timezone')
}
