import { type PluginLocaleBundles, usePluginI18n } from '@hermes/plugin-sdk'
import { useMemo } from 'react'

const en = {
  nav: 'My Mail',
  title: 'My Mail',
  subtitle: 'Send and receive mail safely and efficiently with Yuanjing Digital Employee · powered by Agent Mail',
  compose: 'Compose',
  enable: 'Confirm enable',
  enableDescription:
    'Agent Mail creates a mailbox for your Yuanjing Digital Employee. You can receive or send emails in Yuanjing Digital Employee conversations.',
  enableTitle: 'Enable Yuanjing Digital Employee Agent Mail',
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
  addToConversation: 'Add email to conversation',
  attachments: 'Attachments',
  sender: 'From',
  recipient: 'To',
  sentAt: 'Time',
  download: 'Download',
  close: 'Close',
  confirmDisable: 'Disable Agent Mail? The saved Wo Mail authorization remains on this device for quick re-enable.',
  cancel: 'Cancel',
  error: 'Could not load Agent Mail.'
}

const zh = {
  addToConversation: '\u6dfb\u52a0\u90ae\u4ef6\u5230\u5bf9\u8bdd',
  sender: '\u53d1\u4ef6\u4eba',
  recipient: '\u6536\u4ef6\u4eba',
  sentAt: '\u65f6\u95f4',
  nav: '我的邮箱',
  title: '我的邮箱',
  subtitle: '安全高效地使用 元景数字员工 收发邮件 · 由 Agent Mail 提供服务',
  compose: '发邮件',
  enable: '确认开通',
  enableDescription: '智能体邮箱是为你的 元景数字员工 创建的邮箱。你可以在 元景数字员工 对话中接收或发送邮件。',
  enableTitle: '开通 元景数字员工 智能体邮箱',
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
  attachments: '附件',
  download: '下载',
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
