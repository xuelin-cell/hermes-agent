import type { ConversationShareOwner, ConversationShareRequest } from '@hermes/shared/conversation-share'
import { atom } from 'nanostores'

import { assertSessionOwnerResolved } from './session-owner-resolution'
import { isSessionOwnerRoute } from './session-request-router'
import { knownOwnerForSession } from './session-states'

export interface ConversationShareTarget {
  owner: ConversationShareOwner
  request: ConversationShareRequest
}

export const $conversationShareTarget = atom<ConversationShareTarget | null>(null)

/** 在用户点击时固定会话所属后端，不能用随后切换的活动 profile 猜测。 */
export function openConversationShare(sessionId: string, responseRowId?: number): void {
  const owner = knownOwnerForSession(sessionId)
  assertSessionOwnerResolved(owner, { sessionId, method: 'conversation.share' })
  $conversationShareTarget.set({
    owner: isSessionOwnerRoute(owner)
      ? { connectionId: owner.connectionId, profile: owner.targetProfile || owner.profile }
      : { profile: owner || undefined },
    request: { sessionId, scope: responseRowId ? 'response' : 'session', responseRowId }
  })
}

/** 关闭所有入口共用的分享窗口，具体取消由窗口生命周期处理。 */
export function closeConversationShare(): void {
  $conversationShareTarget.set(null)
}
