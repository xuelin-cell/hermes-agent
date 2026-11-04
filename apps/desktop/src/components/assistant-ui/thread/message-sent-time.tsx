import { useAuiState } from '@assistant-ui/react'

import { useI18n } from '@/i18n'
import { formatFooterTime, parseMessageTime } from '@/lib/message-time'

export function MessageSentTime() {
  const timestamp = useAuiState(s => parseMessageTime(s.message.metadata?.custom?.timelineTimestamp))
  const { locale, t } = useI18n()

  if (timestamp === undefined) {
    return null
  }

  return (
    <time
      className="self-end px-1.5 pt-1 text-xs font-medium leading-5 tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover/user-message:opacity-100 group-focus-within/user-message:opacity-100"
      data-slot="aui_user-sent-time"
      dateTime={new Date(timestamp * 1000).toISOString()}
    >
      {formatFooterTime(timestamp, locale, t.assistant.thread.footerYesterday)}
    </time>
  )
}
