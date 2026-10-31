import { beforeEach, describe, expect, it } from 'vitest'

import {
  $announcements,
  $unreadAnnouncements,
  markAllAnnouncementsRead,
  markAnnouncementRead,
  openMessageCenterScope,
  receiveAnnouncement,
  resetMessageCenter
} from './message-center'

const announcement = (id: string, at: number, text = '正文') => ({
  at,
  id,
  priority: 3,
  text,
  title: '标题',
  topic: 'uniwork'
})

beforeEach(() => {
  window.localStorage.clear()
  resetMessageCenter()
  openMessageCenterScope('138****0000')
})

describe('消息中心', () => {
  it('同一 id 只出现一条，按发布时间倒序', () => {
    receiveAnnouncement(announcement('a', 2_000))
    receiveAnnouncement(announcement('b', 3_000))
    receiveAnnouncement(announcement('a', 2_000))

    expect($announcements.get().map(item => item.id)).toEqual(['b', 'a'])
  })

  it('重启后从本地恢复，已读状态一并保留', () => {
    receiveAnnouncement(announcement('a', 2_000))
    markAnnouncementRead('a')

    // 模拟重启：清空内存后重新打开同一账号。
    resetMessageCenter()
    openMessageCenterScope(null)
    openMessageCenterScope('138****0000')

    const restored = $announcements.get()

    expect(restored).toHaveLength(1)
    expect(restored[0].id).toBe('a')
    expect(restored[0].readAt).toBeTypeOf('number')
    expect($unreadAnnouncements.get()).toBe(0)
  })

  it('未读数只统计未读，全部已读后清零', () => {
    receiveAnnouncement(announcement('a', 2_000))
    receiveAnnouncement(announcement('b', 3_000))

    expect($unreadAnnouncements.get()).toBe(2)

    markAnnouncementRead('a')

    expect($unreadAnnouncements.get()).toBe(1)

    markAllAnnouncementsRead()

    expect($unreadAnnouncements.get()).toBe(0)
  })

  it('换账号不串号：另一个账号看不到前一个账号的公告', () => {
    receiveAnnouncement(announcement('a', 2_000))

    openMessageCenterScope('139****1111')

    expect($announcements.get()).toEqual([])

    receiveAnnouncement(announcement('x', 4_000))

    openMessageCenterScope('138****0000')

    expect($announcements.get().map(item => item.id)).toEqual(['a'])
  })

  it('坏记录被丢弃，不影响其余公告', () => {
    receiveAnnouncement(announcement('a', 2_000))
    window.localStorage.setItem(
      'uniwork.desktop.messageCenter.v1:138****0000',
      JSON.stringify([{ id: 'a', at: 2_000, priority: 3, text: '正文', title: '标题', topic: 'uniwork', readAt: null }, null, { id: '' }])
    )

    resetMessageCenter()
    openMessageCenterScope(null)
    openMessageCenterScope('138****0000')

    expect($announcements.get().map(item => item.id)).toEqual(['a'])
  })
})
