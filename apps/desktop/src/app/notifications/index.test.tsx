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

it('列表与未读计数来自消息中心 store，页面不是浮层', () => {
  $announcements.set([announcement('a'), announcement('b', AT)])
  mount()

  // 整页标题（h1）证明它渲染为工作区页面而不是面板卡片。
  expect(screen.getByRole('heading', { level: 1, name: '消息中心' })).toBeTruthy()
  expect(screen.getByText('1 条未读消息')).toBeTruthy()
  expect(screen.getByText('标题-a')).toBeTruthy()
  expect(screen.getByText('标题-b')).toBeTruthy()
})

it('点击单条通知即标记已读，未读数随之清零且不删除记录', () => {
  $announcements.set([announcement('a')])
  mount()

  fireEvent.click(screen.getByRole('button', { name: '标题-a' }))

  expect(screen.getByText('没有未读通知')).toBeTruthy()
  expect($unreadAnnouncements.get()).toBe(0)
  // 已读只是状态，列表条目仍在页面上。
  expect(screen.getByText('标题-a')).toBeTruthy()
})

it('全部已读清空未读角标，无未读时按钮不可点', () => {
  $announcements.set([announcement('a'), announcement('b')])
  mount()

  const markAll = screen.getByRole<HTMLButtonElement>('button', { name: '全部已读' })
  fireEvent.click(markAll)

  expect($unreadAnnouncements.get()).toBe(0)
  expect(markAll.disabled).toBe(true)
})

it('搜索按标题与正文过滤，无命中时给出空状态', () => {
  $announcements.set([announcement('a'), announcement('b')])
  mount()

  fireEvent.change(screen.getByLabelText('搜索通知…'), { target: { value: '标题-a' } })
  expect(screen.getByText('标题-a')).toBeTruthy()
  expect(screen.queryByText('标题-b')).toBeNull()

  fireEvent.change(screen.getByLabelText('搜索通知…'), { target: { value: '不存在' } })
  expect(screen.getByText('没有匹配的通知')).toBeTruthy()
})

it('没有任何通知时渲染空状态而不是空列表', () => {
  mount()

  expect(screen.getByText('暂无通知')).toBeTruthy()
  expect(screen.getByText('收到的新公告会显示在这里。')).toBeTruthy()
})
