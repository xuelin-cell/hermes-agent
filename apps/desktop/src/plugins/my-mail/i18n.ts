import { type PluginLocaleBundles, usePluginI18n } from '@hermes/plugin-sdk'
import { useMemo } from 'react'

const en = {
  nav: 'My Mail',
  title: 'My Mail',
  subtitle: 'Use Hermes to receive and send email securely · Powered by Agent Mail',
  compose: 'Compose',
  enable: 'Enable Agent Mail',
  enableHint: 'Enable the dedicated Wo Mail account associated with your signed-in phone number.',
  enabling: 'Enabling…',
  running: 'Running',
  disable: 'Disable',
  inbox: 'Inbox',
  sent: 'Sent',
  delete: 'Delete',
  refresh: 'Refresh',
  search: 'Search subject, sender or body',
  todaySent: 'Sent today',
  loading: 'Loading mail…',
  empty: 'No mail here yet.',
  loadMore: 'Load more',
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
  reply: 'Reply with Agent',
  forward: 'Forward with Agent',
  close: 'Close',
  confirmDisable: 'Disable Agent Mail? The saved Wo Mail authorization remains on this device for quick re-enable.',
  cancel: 'Cancel',
  error: 'Could not load Agent Mail.'
}

const zh = {
  nav: '我的邮箱',
  title: '我的邮箱',
  subtitle: '安全高效地使用 Hermes 收发邮件 · 由 Agent Mail 提供服务',
  compose: '发邮件',
  enable: '开通智能体邮箱',
  enableHint: '使用当前登录手机号开通专属沃邮箱，授权信息只保存在本机。',
  enabling: '正在开通…',
  running: '运行中',
  disable: '停用',
  inbox: '收信记录',
  sent: '发信记录',
  delete: '删除',
  refresh: '刷新',
  search: '搜索邮件主题、发件人或正文',
  todaySent: '今日发信',
  loading: '正在加载邮件…',
  empty: '这里还没有邮件。',
  loadMore: '加载更多',
  today: '今天',
  yesterday: '昨天',
  earlier: '更早',
  reply: '让智能体回复',
  forward: '让智能体转发',
  close: '关闭',
  confirmDisable: '确定停用智能体邮箱吗？沃邮箱授权仍会安全保存在本机，方便下次重新启用。',
  cancel: '取消',
  error: '智能体邮箱加载失败。'
}

export const MY_MAIL_LOCALES: PluginLocaleBundles = { en, zh }

type Messages = typeof en

export function useMailText(): Messages {
  const t = usePluginI18n('my-mail')

  return useMemo(() => Object.fromEntries(Object.keys(en).map(key => [key, t(key)])) as unknown as Messages, [t])
}
