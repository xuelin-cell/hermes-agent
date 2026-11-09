import type { ConversationShareOwner, ConversationShareRequest } from '@hermes/shared/conversation-share'
import { atom } from 'nanostores'

import { resolveSessionOwner } from '@/app/session/hooks/use-session-actions/utils'

import { logErrorToDesktopLog, notify, notifyError } from './notifications'
import {
  assertSessionOwnerResolved,
  isSessionOwnerResolutionError,
  sessionOwnerIsKnown
} from './session-owner-resolution'
import { isSessionOwnerRoute } from './session-request-router'
import { knownOwnerForSession, storedSessionIdForRuntimeId } from './session-states'

export interface ConversationShareTarget {
  owner: ConversationShareOwner
  request: ConversationShareRequest
}

export const $conversationShareTarget = atom<ConversationShareTarget | null>(null)

/** 在用户点击时固定会话所属后端，不能用随后切换的活动 profile 猜测。
 *  同步线索（已加载的会话行、分屏、缓存提示）缺失时，与其他会话请求一样跨 profile 向后端探测；
 *  侧栏分页外、从搜索打开或刚创建的会话都依赖这一步。 */
export async function openConversationShare(sessionId: string, responseRowId?: number): Promise<void> {
  let owner = knownOwnerForSession(sessionId)

  if (!sessionOwnerIsKnown(owner)) {
    owner = (await resolveSessionOwner(storedSessionIdForRuntimeId(sessionId) ?? sessionId)) ?? owner
  }

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

/** 三个分享入口共用的失败提示：归属无法确认时给出可操作的中文说明，原始错误仍写入桌面日志。 */
export function notifyConversationShareError(
  error: unknown,
  copy: { unavailable: string; ownerUnknown: string }
): void {
  if (!isSessionOwnerResolutionError(error)) {
    notifyError(error, copy.unavailable)

    return
  }

  logErrorToDesktopLog(error, copy.unavailable)
  notify({ kind: 'error', title: copy.unavailable, message: copy.ownerUnknown })
}
