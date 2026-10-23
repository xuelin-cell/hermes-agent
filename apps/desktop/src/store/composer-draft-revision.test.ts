import { afterEach, describe, expect, it } from 'vitest'

import { clearSessionDraft, clearSessionDraftIfUnchanged, sessionDraftRevision, stashSessionDraft, takeSessionDraft } from './composer'

afterEach(() => clearSessionDraft(null))

describe('发送被接受后清新对话草稿（desktop-mt）', () => {
  it('发送后没人再写过就清掉', () => {
    stashSessionDraft(null, '第一条', [])
    const revision = sessionDraftRevision(null)

    clearSessionDraftIfUnchanged(null, revision)

    expect(takeSessionDraft(null).text).toBe('')
  })

  it('发送后又写进了另一个新对话的草稿就保留', () => {
    stashSessionDraft(null, '第一条', [])
    const revision = sessionDraftRevision(null)
    stashSessionDraft(null, '第二个新对话的草稿', [])

    clearSessionDraftIfUnchanged(null, revision)

    expect(takeSessionDraft(null).text).toBe('第二个新对话的草稿')
  })

  it('两次写的是同一段文字也按写过算', () => {
    stashSessionDraft(null, '帮我写生日祝福', [])
    const revision = sessionDraftRevision(null)
    stashSessionDraft(null, '帮我写生日祝福', [])

    clearSessionDraftIfUnchanged(null, revision)

    expect(takeSessionDraft(null).text).toBe('帮我写生日祝福')
  })

  it('各个会话的草稿分开计数', () => {
    const revision = sessionDraftRevision(null)
    stashSessionDraft('stored-b', '别的会话', [])

    expect(sessionDraftRevision(null)).toBe(revision)

    clearSessionDraft('stored-b')
  })
})
