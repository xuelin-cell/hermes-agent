import { useStore } from '@nanostores/react'

import { useSessionView } from '@/app/chat/session-view'
import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button'
import { useI18n } from '@/i18n'
import { isConversationShareHidden } from '@/lib/browser-shell'
import { Share2 } from '@/lib/icons'
import { openConversationShare } from '@/store/conversation-share'
import { notifyError } from '@/store/notifications'

/** 顶部入口固定使用所在会话的身份与运行状态，复用菜单中的分享流程。 */
export function ConversationSessionShareButton({ sessionId }: { sessionId?: string | null }) {
  const view = useSessionView()
  const storedId = useStore(view.$storedId)
  const runtimeId = useStore(view.$runtimeId)
  const busy = useStore(view.$busy)
  const awaiting = useStore(view.$awaitingResponse)
  const { t } = useI18n()

  const targetId = sessionId === undefined ? storedId || runtimeId : sessionId

  if (!targetId || isConversationShareHidden()) {
    return null
  }

  return (
    <TooltipIconButton
      className="pointer-events-auto shrink-0 [-webkit-app-region:no-drag]"
      disabled={busy || awaiting}
      onClick={() => {
        try {
          openConversationShare(targetId)
        } catch (error) {
          notifyError(error, t.conversationShare.unavailable)
        }
      }}
      side="bottom"
      size="icon-sm"
      tooltip={t.conversationShare.sessionShare}
    >
      <Share2 aria-hidden="true" />
    </TooltipIconButton>
  )
}
