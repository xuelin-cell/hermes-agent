import { useAuiState } from '@assistant-ui/react'

import { prettifyModelId } from '@/app/settings/models-mt/model-name'
import { useI18n } from '@/i18n'
import { formatFooterTime, parseMessageTime } from '@/lib/message-time'
import { parseTurnReplyModel } from '@/lib/turn-reply-model'
import { parseTurnTokenUsage } from '@/lib/turn-token-usage'

import { TurnTokenUsage } from './turn-token-usage'

export function ReplyMetadata() {
  const rawModel = useAuiState(s => s.message.metadata?.custom?.turnModel)
  const rawTokens = useAuiState(s => s.message.metadata?.custom?.turnTokenUsage)
  const completedAt = useAuiState(s => parseMessageTime(s.message.metadata?.custom?.turnCompletedAt))
  const { locale, t } = useI18n()
  const model = parseTurnReplyModel(rawModel)
  const tokens = parseTurnTokenUsage(rawTokens)

  if (!model && !tokens && completedAt === undefined) {
    return null
  }

  const name = model ? model.name || prettifyModelId(model.model) : ''

  return (
    <div className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 border-l border-muted-foreground/95 pl-2 text-xs leading-none text-muted-foreground">
      {tokens && <TurnTokenUsage />}
      {tokens && model && (
        <span aria-hidden="true" className="opacity-70">
          ·
        </span>
      )}
      {model && (
        <span className="min-w-0 max-w-full truncate font-medium" data-slot="aui_reply-model">
          {name}
        </span>
      )}
      {completedAt !== undefined && (
        <span className="inline-flex items-center gap-2 font-medium" data-slot="aui_reply-completed">
          {(model || tokens) && (
            <span aria-hidden="true" className="opacity-70">
              ·
            </span>
          )}
          <time dateTime={new Date(completedAt * 1000).toISOString()}>
            {formatFooterTime(completedAt, locale, t.assistant.thread.footerYesterday)}
          </time>
        </span>
      )}
    </div>
  )
}
