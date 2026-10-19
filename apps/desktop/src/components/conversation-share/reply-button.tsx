import { useStore } from '@nanostores/react'

import { useSessionView } from '@/app/chat/session-view'
import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button'
import { useI18n } from '@/i18n'
import { isConversationShareHidden } from '@/lib/browser-shell'
import { Share2 } from '@/lib/icons'
import { openConversationShare } from '@/store/conversation-share'
import { notifyError } from '@/store/notifications'

interface ConversationReplyShareButtonProps {
  messageId: string
}

/** 分享整轮回复，以持久行号定位，不依赖当前虚拟列表中可见的最后一段。 */
export function ConversationReplyShareButton({ messageId }: ConversationReplyShareButtonProps) {
  const view = useSessionView()
  const messages = useStore(view.$messages)
  const busy = useStore(view.$busy)
  const awaiting = useStore(view.$awaitingResponse)
  const storedId = useStore(view.$storedId)
  const runtimeId = useStore(view.$runtimeId)
  const { t } = useI18n()
  const message = messages.find(item => item.id === messageId)
  const sessionId = storedId || runtimeId

  if (!message?.rowId || !sessionId || message.interim || isConversationShareHidden()) {
    return null
  }

  return (
    <TooltipIconButton
      disabled={busy || awaiting}
      onClick={() => {
        try {
          openConversationShare(sessionId, message.rowId)
        } catch (error) {
          notifyError(error, t.conversationShare.unavailable)
        }
      }}
      tooltip={t.conversationShare.responseShare}
    >
      <Share2 className="size-3.5" />
    </TooltipIconButton>
  )
}
