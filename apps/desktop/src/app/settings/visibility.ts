const DEVELOPER_SETTINGS = new Set<string>([
  'config:model',
  'config:chat',
  'notifications',
  'config:workspace',
  'config:advanced',
  'config:browser',
  'config:memory',
  'config:voice',
  'vault',
  'gateway',
  'connections',
  'billing',
  'keybinds',
  // 普通用户改用「模型」页（models-mt），提供方的完整管理留给开发者模式。
  'providers'
])

/** 根据开发者模式统一决定设置入口是否可见。 */
export function settingsViewVisible(view: string, developerMode: boolean): boolean {
  return developerMode || !DEVELOPER_SETTINGS.has(view)
}

/** 按设置分组与字段控制开发者专属字段，避免搜索结果泄露隐藏项。 */
export function settingsFieldVisible(view: string, field: string, developerMode: boolean): boolean {
  if (!developerMode && view === 'config:safety') {
    return !['approvals.mcp_reload_confirm', 'command_allowlist'].includes(field) && !field.startsWith('security.') && !field.startsWith('checkpoints.')
  }

  return developerMode || !(view === 'config:chat' && field === 'timezone')
}
