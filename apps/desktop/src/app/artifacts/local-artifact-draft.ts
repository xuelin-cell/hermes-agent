import { $apiRequestScope } from '@/api/client'
import { requestComposerGetDraft, requestComposerSetDraft } from '@/app/chat/composer/focus'
import {
  createComposerAttachmentOccurrenceId,
  NEW_SESSION_DRAFT_KEY,
  stashSessionDraft,
  takeSessionDraft
} from '@/store/composer'
import {
  $newChatConnectionId,
  $newChatProfile,
  $newChatRoute,
  newSessionInAgent,
  resolveNewChatOwnerRoute
} from '@/store/profile'
import { $activeSessionId, $connection, $selectedStoredSessionId } from '@/store/session'

import type { LocalArtifact } from './local-artifact-model'

/** 本机文件加入新会话草稿，正文和旧附件保持原样，发送仍走 Hermes 原生附件处理。 */
export async function addLocalArtifactDraft(file: LocalArtifact, isCurrent: () => boolean): Promise<boolean> {
  const connection = $connection.get()
  const scope = $apiRequestScope.get()
  const profile = scope.profile || connection?.profile || 'default'
  const owner = resolveNewChatOwnerRoute()
  const selected = $selectedStoredSessionId.get()
  const active = $activeSessionId.get()
  const draftProfile = $newChatProfile.get()
  const draftRoute = $newChatRoute.get()
  const draftConnection = $newChatConnectionId.get()

  /** 原会话切换与 Profile 切换一样会使本次草稿操作失效。 */
  const current = () =>
    isCurrent() &&
    $connection.get() === connection &&
    $apiRequestScope.get() === scope &&
    $selectedStoredSessionId.get() === selected &&
    $activeSessionId.get() === active &&
    $newChatProfile.get() === draftProfile &&
    $newChatRoute.get() === draftRoute &&
    $newChatConnectionId.get() === draftConnection

  if (
    !file.resolvedPath ||
    file.connectionId !== 'local' ||
    connection?.mode !== 'local' ||
    (scope.connectionId && scope.connectionId !== 'local') ||
    (owner && (owner.connectionId !== 'local' || owner.profile !== profile))
  ) {
    return false
  }

  const metadata = await window.hermesDesktop.normalizePreviewTarget(file.resolvedPath).catch(() => null)

  if (!metadata?.path || !current()) {
    return false
  }

  const live = await requestComposerGetDraft([NEW_SESSION_DRAFT_KEY])

  if (!current()) {
    return false
  }

  // 已有会话的输入框不拥有 __new__；仅拒绝已挂载却不能回答的新草稿输入框。
  if (!live && !selected && !active && document.querySelector('[data-composer-target="main"]')) {
    return false
  }

  const draft = live || takeSessionDraft(NEW_SESSION_DRAFT_KEY)
  const attachments = [...(draft.attachments || [])]

  if (!attachments.some(item => item.path === metadata.path)) {
    attachments.push({
      id: `file:${metadata.path}`,
      occurrenceId: createComposerAttachmentOccurrenceId(),
      kind: metadata.previewKind === 'image' ? 'image' : 'file',
      label: file.label,
      path: metadata.path,
      detail: metadata.path
    })
  }

  if (live) {
    if (!(await requestComposerSetDraft([NEW_SESSION_DRAFT_KEY], draft.text || '', { attachments }))) {
      return false
    }
  } else {
    stashSessionDraft(NEW_SESSION_DRAFT_KEY, draft.text || '', attachments)
  }

  newSessionInAgent({ connectionId: 'local', profile, mode: 'local' })

  return true
}
