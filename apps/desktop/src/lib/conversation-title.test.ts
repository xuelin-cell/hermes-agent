import { describe, expect, it } from 'vitest'

import {
  $cronSessions,
  $messagingSessions,
  $sessions,
  applySessionTitle,
  setCronSessions,
  setMessagingSessions,
  setSessions
} from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import {
  observeTitle,
  reconcileTitleRead,
  temporaryConversationTitle,
  titleOwnerMatches,
  titleReadRevision
} from './conversation-title'

/** 最小真实会话行，使用相同ID刻意验证跨Profile隔离。 */
function row(profile: string, connection = 'local'): SessionInfo {
  return {
    id: 'same-id',
    profile,
    connection_id: connection,
    title: '原标题',
    _lineage_root_id: 'root',
    _lineage_ids: ['root', 'same-id']
  } as SessionInfo
}

describe('会话标题统一显示', () => {
  it('普通输入、纯文件、图片和纯粘贴均即时命名，中文按可见字符限长', () => {
    expect(temporaryConversationTitle('分析合同风险', [{ label: '123.pdf' }])).toBe('分析合同风险')
    expect(temporaryConversationTitle('', [{ label: '操作手册.png' }])).toBe('操作手册.png')
    expect(
      temporaryConversationTitle('', [{ label: '324.txt', titlePreview: '关于新能源汽车市场的年度调研报告' }])
    ).toBe('关于新能源汽车市场的年度调研报告')
    expect(temporaryConversationTitle('', [{ label: 'A.pdf' }, { label: 'B.pdf' }])).toBe('A.pdf 等2个文件')
    expect([
      ...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(temporaryConversationTitle('👩‍💻'.repeat(30), []))
    ]).toHaveLength(24)
  })
  it('侧边栏各切片按谱系同步，B上下文不覆盖A，也不覆盖另一后端', () => {
    setSessions([row('a'), row('b'), row('a', 'remote')])
    setCronSessions([row('a')])
    setMessagingSessions([row('a')])
    applySessionTitle('root', '正式标题', { profile: 'a', connectionId: 'local' })
    expect($sessions.get().map(item => item.title)).toEqual(['正式标题', '原标题', '原标题'])
    expect($cronSessions.get()[0].title).toBe('正式标题')
    expect($messagingSessions.get()[0].title).toBe('正式标题')
    applySessionTitle('same-id', 'B标题', { profile: 'b', connectionId: 'local' })
    expect($sessions.get()[0].title).toBe('正式标题')
    expect(titleOwnerMatches(row('a', 'remote'), { profile: 'a', connectionId: 'local' })).toBe(false)
  })
  it('旧列表和旧自动标题读取不能回滚手动改名，新权威读仍可更新', () => {
    const a = row('race'),
      b = row('other'),
      start = titleReadRevision()

    observeTitle(a, '用户改名')
    expect(reconcileTitleRead(a, start).title).toBe('用户改名')
    expect(reconcileTitleRead(b, start).title).toBe('原标题')
    expect(reconcileTitleRead({ ...a, title: '另一个窗口的改名' }, titleReadRevision()).title).toBe('另一个窗口的改名')
  })
})
