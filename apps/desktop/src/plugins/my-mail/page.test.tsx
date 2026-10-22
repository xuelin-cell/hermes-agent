import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { enableMail, mailStatus } = vi.hoisted(() => ({ enableMail: vi.fn(), mailStatus: vi.fn() }))

vi.mock('@hermes/plugin-sdk', () => ({
  host: { state: { profile: {} } },
  useValue: () => 'default',
  usePluginI18n: () => (key: string) => key
}))

vi.mock('./api', () => ({
  deleteMessage: vi.fn(),
  disableMail: vi.fn(),
  enableMail,
  getMessage: vi.fn(),
  listFolders: vi.fn(),
  listMessages: vi.fn(),
  mailStatus,
  markRead: vi.fn(),
  searchMessages: vi.fn()
}))

vi.mock('./i18n', () => ({
  useMailText: () => ({
    cancel: '取消',
    close: '关闭',
    compose: '发邮件',
    confirmDisable: '',
    delete: '删除',
    disable: '停用',
    earlier: '更早',
    empty: '暂无邮件',
    enable: '确认开通',
    enableDescription: '智能体邮箱是为你的 元景数字员工 创建的邮箱。你可以在 元景数字员工 对话中接收或发送邮件。',
    enableTitle: '开通 元景数字员工 智能体邮箱',
    enabling: '开通中…',
    error: '加载失败',
    forward: '转发',
    inbox: '收信记录',
    loadMore: '加载更多',
    loading: '加载中…',
    refresh: '刷新',
    reply: '回复',
    running: '运行中',
    search: '搜索',
    sent: '发信记录',
    subtitle: '安全高效地使用 元景数字员工 收发邮件 · 由 Agent Mail 提供服务',
    title: '我的邮箱',
    today: '今天',
    todaySent: '今日发信',
    yesterday: '昨天'
  })
}))

describe('MyMailPage disabled state', () => {
  beforeEach(() => {
    enableMail.mockResolvedValue({ status: { dailyQuota: 50, email: '13800138000@wo.cn', enabled: true, todaySent: 0 } })
    mailStatus.mockResolvedValue({ status: { dailyQuota: 50, email: '', enabled: false, todaySent: 0 } })
  })

  it('matches the HexAgent page header and horizontal enable card', async () => {
    const { MyMailPage } = await import('./page')

    render(<MyMailPage />)

    expect(await screen.findByRole('heading', { level: 1, name: '我的邮箱' })).toBeTruthy()
    expect(screen.getByText('安全高效地使用 元景数字员工 收发邮件 · 由 Agent Mail 提供服务')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: '开通 元景数字员工 智能体邮箱' })).toBeTruthy()
    expect(screen.getByText('智能体邮箱是为你的 元景数字员工 创建的邮箱。你可以在 元景数字员工 对话中接收或发送邮件。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '确认开通' })).toBeTruthy()
  })

  it('keeps the existing enable action behind the HexAgent entry button', async () => {
    const { MyMailPage } = await import('./page')

    render(<MyMailPage />)

    fireEvent.click(await screen.findByRole('button', { name: '确认开通' }))

    await waitFor(() => expect(enableMail).toHaveBeenCalledWith('default'))
  })
})
