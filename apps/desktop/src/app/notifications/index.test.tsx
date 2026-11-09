import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n/context'
import { $announcements, $unreadAnnouncements, type AnnouncementRecord } from '@/store/message-center'

import { NotificationsView } from './index'

const AT = 1_760_000_000_000

function announcement(id: string, readAt: number | null = null): AnnouncementRecord {
  return { at: AT, id, priority: 3, readAt, text: `正文-${id}`, title: `标题-${id}`, topic: 'uniwork' }
}

function mount(): void {
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter>
        <NotificationsView />
      </MemoryRouter>
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  $announcements.set([])
})

it('列表来自消息中心 store，页面不是浮层', () => {
  $announcements.set([announcement('a'), announcement('b', AT)])
  mount()

  // 整页标题（h1）证明它渲染为工作区页面而不是面板卡片。
  expect(screen.getByRole('heading', { level: 1, name: '消息中心' })).toBeTruthy()
  expect(screen.getByText('标题-a')).toBeTruthy()
  expect(screen.getByText('标题-b')).toBeTruthy()
})

it('header 不再渲染未读提示与「全部已读」，也不留空按钮位', () => {
  $announcements.set([announcement('a')])
  mount()

  const header = screen.getByRole('heading', { level: 1, name: '消息中心' }).parentElement!

  // 只剩标题本身：无状态文案、无「全部已读」按钮。
  expect(header.textContent).toBe('消息中心')
  expect(screen.queryByText('1 条未读消息')).toBeNull()
  expect(screen.queryByText('没有未读通知')).toBeNull()
  expect(screen.queryByRole('button', { name: '全部已读' })).toBeNull()
})

it('按天分组：同一天的公告落在同一个日期标题下', () => {
  const nextDay = AT + 24 * 60 * 60 * 1000

  $announcements.set([announcement('a'), { ...announcement('c'), at: nextDay }])
  mount()

  // 分组标题是 YYYY-MM-DD，日期由分组承载，不再逐条重复时间。
  const days = screen.getAllByRole('heading', { level: 2 })

  expect(days).toHaveLength(2)

  for (const day of days) {
    expect(day.textContent).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  }
})

it('点击单条通知即标记已读，不删除记录', () => {
  $announcements.set([announcement('a')])
  mount()

  fireEvent.click(screen.getByRole('button', { name: '标题-a' }))

  // 页面不再展示未读计数，用同一份 store 状态断言行为未变。
  expect($unreadAnnouncements.get()).toBe(0)
  // 已读只是状态，列表条目仍在页面上。
  expect(screen.getByText('标题-a')).toBeTruthy()
})

it('没有任何通知时渲染空状态而不是空列表', () => {
  mount()

  expect(screen.getByText('暂无通知')).toBeTruthy()
  expect(screen.getByText('收到的新公告会显示在这里。')).toBeTruthy()
})
