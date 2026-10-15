import { type PluginLocaleBundles } from '@hermes/plugin-sdk'

const en = {
  title: 'Kits',
  kits: 'Kits',
  experts: 'Experts',
  emptyKits: 'No kits installed yet.',
  emptyExperts: 'No experts installed yet. An expert shows up in the Bots list after install.',
  installZip: 'Install from zip',
  refresh: 'Refresh triggers',
  uninstall: 'Uninstall',
  confirmExpert: 'Uninstall deletes this expert’s profile, chats, and memory. Click again to confirm.',
  enable: 'Enabled',
  saveConfig: 'Save',
  authorize: 'Authorize',
  authorizing: 'Opening the login page…',
  authorized: 'Authorized',
  receipt: 'Receipt',
  skills: 'skills',
  agents: 'dispatch',
  mcp: 'MCP',
  missing: 'Missing',
  job: 'Working…',
  failed: 'Failed'
}

const zh = {
  title: '套件',
  kits: '套件',
  experts: '专家',
  emptyKits: '还没有安装套件。',
  emptyExperts: '还没有安装专家。装好之后从 Bots 列表进入对话。',
  installZip: '从 zip 安装',
  refresh: '刷新触发词',
  uninstall: '卸载',
  confirmExpert: '卸载会删除这个专家的整个 profile、对话和记忆。再点一次确认。',
  enable: '启用',
  saveConfig: '保存',
  authorize: '去授权',
  authorizing: '正在打开登录页…',
  authorized: '已授权',
  receipt: '回执',
  skills: '技能',
  agents: '派工',
  mcp: 'MCP',
  missing: '缺',
  job: '正在处理…',
  failed: '失败'
}

export const KITS_LOCALES: PluginLocaleBundles = { en, zh }
